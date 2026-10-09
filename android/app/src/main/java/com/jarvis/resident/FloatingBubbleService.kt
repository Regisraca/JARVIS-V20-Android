package com.jarvis.resident

import android.app.Service
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.content.Intent
import android.graphics.PixelFormat
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.ImageView

class FloatingBubbleService : Service() {
    private var bubble: View? = null
    private lateinit var wm: WindowManager
    override fun onCreate() {
        super.onCreate()
        val channelId = "jarvis_resident"
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(channelId, "J.A.R.V.I.S.", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        val notification = Notification.Builder(this, channelId)
            .setContentTitle("J.A.R.V.I.S. ativo")
            .setContentText("A bolha flutuante está disponível.")
            .setSmallIcon(R.drawable.ic_jarvis_bubble)
            .build()
        startForeground(17, notification)
        if (!Settings.canDrawOverlays(this)) return
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val icon = ImageView(this).apply {
            setImageResource(R.drawable.ic_jarvis_bubble)
            setOnClickListener { startActivity(Intent(this@FloatingBubbleService, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        val type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        val p = WindowManager.LayoutParams(72, 72, type, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.END; x = 20; y = 180
        }
        bubble = icon
        wm.addView(icon, p)
    }
    override fun onDestroy() {
        bubble?.let { view ->
            try {
                if (::wm.isInitialized) wm.removeView(view)
            } catch (_: Exception) {
                // A bolha pode já ter sido removida pelo sistema durante o encerramento.
            }
        }
        bubble = null
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
