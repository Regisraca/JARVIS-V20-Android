package com.jarvis.resident

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.BatteryManager
import android.provider.Settings

/**
 * Explicit local commands that require no Termux, Accessibility service or shell.
 * Only the actual user's text goes through this parser, never arbitrary model output.
 */
internal object NativeDeviceActions {
    fun execute(activity: Activity, text: String): String? {
        val normalized = text.trim().lowercase(java.util.Locale.forLanguageTag("pt-BR"))
            .replace(Regex("^jarvis[,! ]+"), "")
        val settings = mapOf(
            "abrir configurações" to Settings.ACTION_SETTINGS,
            "abrir configuracoes" to Settings.ACTION_SETTINGS,
            "abrir configurações do wifi" to Settings.ACTION_WIFI_SETTINGS,
            "abrir configurações do wi-fi" to Settings.ACTION_WIFI_SETTINGS,
            "abrir wifi" to Settings.ACTION_WIFI_SETTINGS,
            "abrir wi-fi" to Settings.ACTION_WIFI_SETTINGS,
            "abrir bluetooth" to Settings.ACTION_BLUETOOTH_SETTINGS
        )
        settings[normalized]?.let { action ->
            return try {
                activity.startActivity(Intent(action))
                "Abri a tela de configurações solicitada. As mudanças dependem de você."
            } catch (_: Exception) { "Não consegui abrir essa tela de configurações." }
        }

        if (normalized in setOf("bateria", "nível da bateria", "nivel da bateria", "quanto tenho de bateria", "qual a bateria")) {
            val status = activity.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = status?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = status?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            return if (level >= 0 && scale > 0) {
                "A bateria está em ${level * 100 / scale}%."
            } else "Não consegui consultar o nível da bateria."
        }

        if (normalized.startsWith("copiar ")) {
            val content = text.trim().replace(Regex("^(?i)(jarvis[,! ]*)?copiar\\s+"), "").take(2000)
            if (content.isBlank()) return "Não encontrei texto para copiar."
            val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("JARVIS", content))
            return "Texto copiado para a área de transferência."
        }

        val sites = mapOf(
            "abrir youtube" to "https://www.youtube.com/",
            "abrir google" to "https://www.google.com/",
            "abrir whatsapp" to "https://wa.me/",
            "abrir spotify" to "https://open.spotify.com/",
            "abrir maps" to "https://www.google.com/maps",
            "abrir mapas" to "https://www.google.com/maps"
        )
        sites[normalized]?.let { url ->
            return try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                "Solicitei a abertura do aplicativo ou site correspondente."
            } catch (_: Exception) {
                "Não encontrei um aplicativo para abrir esse destino."
            }
        }
        return null
    }
}
