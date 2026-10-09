package com.jarvis.resident

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.speech.RecognizerIntent
import android.speech.tts.TextToSpeech
import java.util.Locale
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.*
import java.util.UUID
import kotlin.concurrent.thread

/**
 * Fully native provider setup + text chat.
 * Hosted WebView JavaScript never receives stored API keys.
 */
class NativeAiActivity : Activity() {
    private lateinit var registry: AiProviderRegistry
    private lateinit var vault: ProviderCredentialVault
    private lateinit var root: LinearLayout
    private lateinit var transcript: TextView
    private lateinit var question: EditText
    private lateinit var send: Button
    private val history = mutableListOf<Pair<String, String>>()
    private var settingsDialog: AlertDialog? = null
    private var speaker: TextToSpeech? = null
    private var voiceEnabled = true

    private fun container() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(24, 18, 24, 18)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        registry = AiProviderRegistry(this)
        vault = ProviderCredentialVault(this)
        speaker = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) speaker?.language = Locale.forLanguageTag("pt-BR")
        }
        root = container()
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        header.addView(Button(this).apply {
            text = "APIs"
            setOnClickListener { showSettings() }
        })
        header.addView(Button(this).apply {
            text = "Nova conversa"
            setOnClickListener { history.clear(); transcript.text = "Como posso ajudar?" }
        })
        header.addView(Button(this).apply {
            text = "Interface web"
            setOnClickListener { startActivity(Intent(this@NativeAiActivity, MainActivity::class.java)) }
        })
        root.addView(header)

        transcript = TextView(this).apply {
            textSize = 16f
            text = "J.A.R.V.I.S. — IA no Android\nConfigure uma ou mais APIs em 'APIs' para começar."
            setTextIsSelectable(true)
            setPadding(8, 12, 8, 12)
        }
        val scroll = ScrollView(this).apply { addView(transcript) }
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        question = EditText(this).apply {
            hint = "Escreva uma mensagem"
            minLines = 2
            maxLines = 5
        }
        root.addView(question)
        send = Button(this).apply {
            text = "Enviar"
            setOnClickListener { sendMessage() }
        }
        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        controls.addView(send, LinearLayout.LayoutParams(0, -2, 2f))
        controls.addView(Button(this).apply {
            text = "🎤"
            contentDescription = "Ditado por voz"
            setOnClickListener {
                try {
                    startActivityForResult(
                        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "pt-BR"),
                        REQUEST_SPEECH
                    )
                } catch (e: Exception) {
                    Toast.makeText(this@NativeAiActivity, "Reconhecimento de voz indisponível", Toast.LENGTH_SHORT).show()
                }
            }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(Button(this).apply {
            text = "🔊"
            contentDescription = "Ativar ou silenciar voz"
            setOnClickListener {
                voiceEnabled = !voiceEnabled
                text = if (voiceEnabled) "🔊" else "🔇"
                if (!voiceEnabled) speaker?.stop()
            }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(controls)
        setContentView(root)
        if (registry.all().isEmpty()) showSettings()
    }

    private fun sendMessage() {
        val text = question.text.toString().trim()
        if (text.isEmpty()) return
        // Only explicit user-entered commands can trigger local Android actions.
        NativeDeviceActions.execute(this, text)?.let { result ->
            question.setText("")
            transcript.append("\n\nVocê: $text\n\nJ.A.R.V.I.S.: $result")
            if (voiceEnabled) speaker?.speak(result, TextToSpeech.QUEUE_FLUSH, null, "jarvis-device-result")
            return
        }
        question.setText("")
        history.add("user" to text)
        transcript.append("\n\nVocê: $text\n\nJ.A.R.V.I.S.: pensando…")
        send.isEnabled = false
        val snapshot = history.takeLast(20).toList()
        thread(name = "jarvis-native-ai") {
            val answer = try {
                Result.success(AiProviderRouter(registry, vault).ask(snapshot))
            } catch (e: Exception) {
                Result.failure<AiAnswer>(e)
            }
            runOnUiThread {
                send.isEnabled = true
                val old = transcript.text.toString().removeSuffix("pensando…")
                answer.fold(
                    onSuccess = { result ->
                        history.add("assistant" to result.text)
                        if (voiceEnabled) speaker?.speak(result.text, TextToSpeech.QUEUE_FLUSH, null, "jarvis-answer")
                        transcript.text = old + result.text +
                            "\n\n[Via ${result.provider} • ${result.model}" +
                            (if (result.attempted > 1) " • fallback após ${result.attempted - 1} falha(s)" else "") + "]"
                    },
                    onFailure = { e ->
                        // Failed turns must not become assistant context.
                        transcript.text = old + "Não foi possível responder: ${e.message}"
                    }
                )
            }
        }
    }

    private fun showSettings() {
        settingsDialog?.dismiss()
        val pane = container()
        pane.addView(TextView(this).apply {
            text = "Provedores configurados (ordem de prioridade)"
            textSize = 18f
        })
        registry.all().forEachIndexed { index, provider ->
            val row = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            row.addView(TextView(this).apply {
                text = "${index + 1}. ${provider.name} — ${provider.model}" +
                    if (provider.enabled) " • ativo" else " • pausado"
            })
            val buttons = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            buttons.addView(Button(this).apply {
                text = "Editar"
                setOnClickListener { showProviderForm(provider) }
            })
            buttons.addView(Button(this).apply {
                text = "Testar"
                setOnClickListener {
                    isEnabled = false
                    val button = this
                    thread(name = "jarvis-provider-test") {
                        val result = try {
                            val key = vault.readForNativeRequest(provider.id)
                                ?: throw IllegalStateException("Chave não cadastrada")
                            AiProviderNetwork.complete(provider, key, listOf("user" to "Responda apenas: OK"))
                            "Conexão confirmada: ${provider.name}"
                        } catch (e: Exception) {
                            "Falha em ${provider.name}: ${e.message ?: "erro desconhecido"}"
                        }
                        runOnUiThread {
                            button.isEnabled = true
                            AlertDialog.Builder(this@NativeAiActivity)
                                .setTitle("Teste de API")
                                .setMessage(result)
                                .setPositiveButton("OK", null).show()
                        }
                    }
                }
            })
            buttons.addView(Button(this).apply {
                text = if (provider.enabled) "Pausar" else "Ativar"
                setOnClickListener {
                    registry.save(provider.copy(enabled = !provider.enabled))
                    showSettings()
                }
            })
            buttons.addView(Button(this).apply {
                text = "↑"
                isEnabled = index > 0
                setOnClickListener {
                    val ids = registry.all().map { it.id }.toMutableList()
                    java.util.Collections.swap(ids, index, index - 1)
                    registry.reorder(ids)
                    showSettings()
                }
            })
            buttons.addView(Button(this).apply {
                text = "Excluir"
                setOnClickListener {
                    AlertDialog.Builder(this@NativeAiActivity).setTitle("Excluir ${provider.name}?")
                        .setMessage("A chave armazenada também será apagada.")
                        .setNegativeButton("Cancelar", null)
                        .setPositiveButton("Excluir") { _, _ ->
                            vault.remove(provider.id)
                            registry.delete(provider.id)
                            showSettings()
                        }.show()
                }
            })
            row.addView(buttons)
            pane.addView(row)
        }
        pane.addView(Button(this).apply {
            text = "+ Adicionar API"
            setOnClickListener { showProviderForm(null) }
        })
        settingsDialog = AlertDialog.Builder(this).setTitle("Configurar IAs").setView(
            ScrollView(this).apply { addView(pane) }
        ).setPositiveButton("Fechar", null).show()
    }

    @Deprecated("Legacy Android speech recognition callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_SPEECH && resultCode == Activity.RESULT_OK) {
            val spoken = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            if (!spoken.isNullOrBlank()) question.setText(spoken)
        }
    }

    override fun onDestroy() {
        settingsDialog?.dismiss()
        speaker?.stop()
        speaker?.shutdown()
        speaker = null
        super.onDestroy()
    }

    companion object {
        private const val REQUEST_SPEECH = 810
    }

    private fun showProviderForm(previous: AiProvider?) {
        settingsDialog?.dismiss()
        settingsDialog = null
        val form = container()
        fun field(label: String, value: String): EditText {
            form.addView(TextView(this).apply { text = label })
            return EditText(this).apply { setText(value); setSingleLine(true); form.addView(this) }
        }
        form.addView(TextView(this).apply {
            text = "Gemini usa o endpoint oficial. OpenAI-compatible aceita OpenAI, Groq e endpoints HTTPS compatíveis."
        })
        val type = Spinner(this)
        type.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, listOf("Gemini", "Groq", "OpenAI", "Outro compatível"))
        val existingChoice = when {
            previous == null || previous.kind == "gemini" -> 0
            previous.endpoint.contains("api.groq.com") -> 1
            previous.endpoint.contains("api.openai.com") -> 2
            else -> 3
        }
        type.setSelection(existingChoice)
        form.addView(type)
        val name = field("Nome", previous?.name ?: "Minha IA")
        val model = field("Modelo (ID exato)", previous?.model ?: "gemini-2.5-flash")
        val endpoint = field("Endpoint HTTPS", previous?.endpoint ?: "https://generativelanguage.googleapis.com/v1beta/models")
        val presets = arrayOf(
            "gemini-2.5-flash" to "https://generativelanguage.googleapis.com/v1beta/models",
            "llama-3.3-70b-versatile" to "https://api.groq.com/openai/v1/chat/completions",
            "gpt-4.1-mini" to "https://api.openai.com/v1/chat/completions"
        )
        type.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (previous == null && position < presets.size) {
                    model.setText(presets[position].first)
                    endpoint.setText(presets[position].second)
                    name.setText(arrayOf("Gemini", "Groq", "OpenAI")[position])
                }
            }
        }
        val key = field("Chave API (deixe vazia para manter a atual)", "").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val enabled = CheckBox(this).apply { text = "Ativo"; isChecked = previous?.enabled ?: true }
        form.addView(enabled)
        val dialog = AlertDialog.Builder(this).setTitle(if (previous == null) "Nova API" else "Editar API")
            .setView(ScrollView(this).apply { addView(form) })
            .setNegativeButton("Cancelar", null)
            .setPositiveButton("Salvar", null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val provider = AiProvider(
                    previous?.id ?: UUID.randomUUID().toString().replace("-", ""),
                    name.text.toString().trim(),
                    if (type.selectedItemPosition == 0) "gemini" else "openai",
                    model.text.toString().trim(),
                    endpoint.text.toString().trim(),
                    enabled.isChecked
                )
                try {
                    if (previous == null && key.text.isBlank()) throw IllegalArgumentException("Informe a chave API.")
                    AiProviderNetwork.validateEndpoint(provider)
                    val newKey = key.text.toString().trim()
                    if (newKey.isNotEmpty()) vault.save(provider.id, newKey)
                    registry.save(provider)
                    dialog.dismiss()
                    Toast.makeText(this, "API salva no aparelho", Toast.LENGTH_SHORT).show()
                    showSettings()
                } catch (e: Exception) {
                    Toast.makeText(this, e.message ?: "Erro ao salvar API", Toast.LENGTH_LONG).show()
                }
            }
        }
        dialog.show()
    }
}
