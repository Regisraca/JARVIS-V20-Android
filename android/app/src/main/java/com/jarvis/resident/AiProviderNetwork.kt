package com.jarvis.resident

import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL

internal data class AiAnswer(val text: String, val provider: String, val model: String, val attempted: Int)

/** Network requests run only from a background thread; API keys never cross the WebView boundary. */
internal object AiProviderNetwork {
    fun validateEndpoint(provider: AiProvider) {
        val uri = Uri.parse(provider.endpoint)
        val host = uri.host ?: throw IllegalArgumentException("Informe uma URL HTTPS válida")
        require(uri.scheme == "https" && uri.userInfo == null && uri.port in listOf(-1, 443)) {
            "Somente HTTPS na porta padrão é permitido"
        }
        require(host.contains(".") && !host.endsWith(".local", true) &&
            !host.equals("localhost", true) && !host.endsWith(".internal", true) &&
            !host.endsWith(".localhost", true) && !host.matches(Regex("[0-9.]+")) &&
            !host.contains(":")) { "Endereço de API não permitido" }
        require(uri.fragment == null && uri.query == null) { "URL não pode conter consulta ou fragmento" }
        require(provider.endpoint.length <= 300) { "URL muito longa" }
        if (provider.kind == "gemini") {
            require(host.equals("generativelanguage.googleapis.com", true)) {
                "Gemini só pode usar o endpoint oficial"
            }
        }
    }

    fun complete(provider: AiProvider, key: String, messages: List<Pair<String, String>>): String {
        validateEndpoint(provider)
        val gemini = provider.kind == "gemini"
        val url = if (gemini) {
            val model = Uri.encode(provider.model)
            provider.endpoint.trimEnd('/') + "/" + model + ":generateContent"
        } else provider.endpoint

        val body = if (gemini) {
            val contents = JSONArray()
            messages.forEach { (role, text) ->
                contents.put(JSONObject().put("role", if (role == "assistant") "model" else "user")
                    .put("parts", JSONArray().put(JSONObject().put("text", text))))
            }
            JSONObject().put("contents", contents).toString()
        } else {
            val entries = JSONArray()
            messages.forEach { (role, text) ->
                entries.put(JSONObject().put("role", role).put("content", text))
            }
            JSONObject().put("model", provider.model).put("messages", entries).toString()
        }

        val connection = (URL(url).openConnection() as HttpURLConnection)
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 12_000
            connection.readTimeout = 35_000
            connection.instanceFollowRedirects = false
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Cache-Control", "no-store")
            if (gemini) connection.setRequestProperty("x-goog-api-key", key)
            else connection.setRequestProperty("Authorization", "Bearer $key")
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            if (status !in 200..299) {
                // Never forward raw provider errors; they can include sensitive request details.
                throw IOException("HTTP $status")
            }
            // Limit the stream while reading: checking length only after readText() can exhaust memory.
            val response = connection.inputStream.bufferedReader().use { reader ->
                val buffer = CharArray(8192)
                val output = StringBuilder()
                while (true) {
                    val count = reader.read(buffer)
                    if (count == -1) break
                    if (output.length + count > 2_000_000) throw IOException("Resposta grande demais")
                    output.append(buffer, 0, count)
                }
                output.toString()
            }
            val json = JSONObject(response)
            val text = if (gemini) {
                val candidates = json.optJSONArray("candidates") ?: JSONArray()
                val parts = candidates.optJSONObject(0)?.optJSONObject("content")?.optJSONArray("parts") ?: JSONArray()
                (0 until parts.length()).joinToString("") { parts.optJSONObject(it)?.optString("text") ?: "" }
            } else {
                json.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content") ?: ""
            }
            require(text.isNotBlank()) { "A IA retornou uma resposta vazia" }
            return text
        } finally {
            connection.disconnect()
        }
    }
}

internal class AiProviderRouter(
    private val registry: AiProviderRegistry,
    private val vault: ProviderCredentialVault
) {
    /** Try enabled providers in the user's configured order; never claim success after an error. */
    fun ask(messages: List<Pair<String, String>>): AiAnswer {
        val providers = registry.all().filter { it.enabled && vault.has(it.id) }
        if (providers.isEmpty()) throw IllegalStateException("Cadastre ao menos uma API nas configurações.")
        var lastError = "Nenhum provedor respondeu"
        providers.forEachIndexed { index, provider ->
            try {
                val key = vault.readForNativeRequest(provider.id)
                    ?: throw IllegalStateException("Credencial não encontrada")
                val text = AiProviderNetwork.complete(provider, key, messages)
                return AiAnswer(text, provider.name, provider.model, index + 1)
            } catch (e: Exception) {
                lastError = "${provider.name}: ${e.message?.take(140) ?: "falha"}"
            }
        }
        throw IOException("Todas as APIs falharam. Última tentativa: $lastError")
    }
}
