package com.jarvis.resident

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var web: WebView
    private var pendingWebPermission: PermissionRequest? = null
    private var overlayPrompted = false

    private val jarvisUri: Uri
        get() = Uri.parse(getString(R.string.jarvis_web_url))

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)

        val startUri = jarvisUri
        if (startUri.scheme != "https" || startUri.host.isNullOrBlank() ||
            startUri.host == "SEU-JARVIS.vercel.app"
        ) {
            Toast.makeText(this, "Configure uma URL HTTPS válida do J.A.R.V.I.S. em strings.xml.", Toast.LENGTH_LONG).show()
            finish()
            return
        }

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = true
            // O Phone Bridge local usa HTTP em 127.0.0.1; mantenha HTTPS para a página principal.
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    if (uri.scheme == "https" && uri.host == startUri.host) return false
                    if (uri.scheme == "https" || uri.scheme == "mailto" || uri.scheme == "tel") {
                        return try {
                            startActivity(Intent(Intent.ACTION_VIEW, uri))
                            true
                        } catch (_: Exception) {
                            true
                        }
                    }
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread {
                        val audioResources = request.resources.filter {
                            it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                        }.toTypedArray()
                        if (audioResources.isEmpty()) {
                            request.deny()
                        } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(audioResources)
                        } else {
                            pendingWebPermission = request
                            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
                        }
                    }
                }

                override fun onPermissionRequestCanceled(request: PermissionRequest) {
                    if (pendingWebPermission == request) pendingWebPermission = null
                }
            }
        }
        setContentView(web)
        web.loadUrl(startUri.toString())

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
        }
        ensureOverlayAndService()
    }

    override fun onResume() {
        super.onResume()
        // Não reabrir a tela de permissão em loop se a pessoa decidir não concedê-la.
        if (::web.isInitialized && Settings.canDrawOverlays(this)) startBubbleService()
    }

    private fun ensureOverlayAndService() {
        if (!Settings.canDrawOverlays(this)) {
            if (!overlayPrompted) {
                overlayPrompted = true
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            }
            return
        }
        startBubbleService()
    }

    private fun startBubbleService() {
        val serviceIntent = Intent(this, FloatingBubbleService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(serviceIntent)
        else startService(serviceIntent)
    }

    @Deprecated("Deprecated in Android API 23; kept for runtime compatibility")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_MIC) {
            val request = pendingWebPermission
            pendingWebPermission = null
            if (request != null) {
                if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                    request.grant(request.resources.filter {
                        it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                    }.toTypedArray())
                } else {
                    request.deny()
                }
            }
        }
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            pendingWebPermission?.deny()
            pendingWebPermission = null
            web.stopLoading()
            web.loadUrl("about:blank")
            web.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val REQUEST_MIC = 17
    }
}
