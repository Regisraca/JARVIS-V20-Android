plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android { namespace = "com.jarvis.resident"; compileSdk = 35
    defaultConfig { applicationId = "com.jarvis.resident"; minSdk = 26; targetSdk = 35; versionCode = 20; versionName = "20.0.0" }
}
