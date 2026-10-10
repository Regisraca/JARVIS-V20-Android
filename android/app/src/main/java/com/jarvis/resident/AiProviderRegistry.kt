package com.jarvis.resident

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Public metadata only. Credentials stay in ProviderCredentialVault (Android Keystore).
 * Each configured endpoint is explicitly HTTPS and is never supplied by remote WebView JS.
 */
internal data class AiProvider(
    val id: String,
    val name: String,
    val kind: String,
    val model: String,
    val endpoint: String,
    val enabled: Boolean = true
)

internal class AiProviderRegistry(context: Context) {
    private val prefs = context.getSharedPreferences("jarvis_ai_provider_settings", Context.MODE_PRIVATE)

    @Synchronized fun all(): List<AiProvider> {
        val raw = prefs.getString("providers", "[]") ?: "[]"
        val items = JSONArray(raw)
        return (0 until items.length()).map { i ->
            val item = items.getJSONObject(i)
            AiProvider(
                item.getString("id"),
                item.getString("name"),
                item.getString("kind"),
                item.getString("model"),
                item.getString("endpoint"),
                item.optBoolean("enabled", true)
            )
        }
    }

    @Synchronized fun save(provider: AiProvider) {
        require(provider.id.matches(Regex("[a-zA-Z0-9_-]{1,64}")))
        require(provider.name.isNotBlank() && provider.name.length <= 80)
        require(provider.model.isNotBlank() && provider.model.length <= 120)
        require(provider.kind in setOf("openai", "gemini"))
        AiProviderNetwork.validateEndpoint(provider)
        val current = all().toMutableList()
        val existing = current.indexOfFirst { it.id == provider.id }
        if (existing >= 0) current[existing] = provider else current.add(provider)
        write(current)
    }

    @Synchronized fun delete(id: String) {
        write(all().filterNot { it.id == id })
    }

    @Synchronized fun reorder(ids: List<String>) {
        val existing = all()
        require(ids.size == existing.size && ids.toSet() == existing.map { it.id }.toSet())
        write(ids.map { id -> existing.first { it.id == id } })
    }

    @Synchronized private fun write(providers: List<AiProvider>) {
        val array = JSONArray()
        providers.forEach { p ->
            array.put(JSONObject().apply {
                put("id", p.id); put("name", p.name); put("kind", p.kind)
                put("model", p.model); put("endpoint", p.endpoint); put("enabled", p.enabled)
            })
        }
        check(prefs.edit().putString("providers", array.toString()).commit())
    }
}
