import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Firebase (Continue with Google, push notifications) turns on when the
// project's google-services.json is present (download it from the Firebase
// console for package com.corxlabs.automa and place it next to this file).
// Without it the app builds and runs, and skips the sign-in step.
val firebaseConfigured = file("google-services.json").exists()
if (firebaseConfigured) {
    apply(plugin = "com.google.gms.google-services")
}

// Release signing comes from keystore.properties (never committed):
//   storeFile=/absolute/path/to/upload-keystore.jks
//   storePassword=...
//   keyAlias=upload
//   keyPassword=...
// Without it, release builds are produced unsigned and debug builds use the
// SDK debug key.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.corxlabs.automa"
    compileSdk = 36

    defaultConfig {
        applicationId = (project.findProperty("automa.applicationId") as String?) ?: "com.corxlabs.automa"
        minSdk = 26
        targetSdk = 36
        versionCode = ((project.findProperty("automa.versionCode") as String?) ?: "1").toInt()
        versionName = (project.findProperty("automa.versionName") as String?) ?: "1.0.0"
        buildConfigField("boolean", "FIREBASE_ENABLED", firebaseConfigured.toString())
    }

    signingConfigs {
        if (keystoreProperties.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
        debug {
            // Same application id and (when keystore.properties exists) the same
            // signing key as release, so one Firebase Android app and one SHA-1
            // fingerprint cover both builds for Google sign-in.
            versionNameSuffix = "-debug"
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf("META-INF/*.version", "META-INF/*.kotlin_module", "kotlin/**", "DebugProbesKt.bin")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.core:core-splashscreen:1.0.1")

    // Firebase Auth + Cloud Messaging, and Credential Manager for "Continue with Google".
    implementation(platform("com.google.firebase:firebase-bom:34.19.0"))
    implementation("com.google.firebase:firebase-auth")
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
}

// Release builds must carry the board UI (see BundledUi.kt). Debug builds may
// skip it and then show the server's own UI.
val checkBundledUi by tasks.registering {
    val index = layout.projectDirectory.file("src/main/assets/ui/index.html").asFile
    val server = layout.projectDirectory.file("src/main/assets/server/automa-server.tar.xz").asFile
    doLast {
        if (!index.exists()) {
            throw GradleException(
                "The board UI is not bundled. From the repository root run `pnpm mobile:bundle-ui`, then build again.",
            )
        }
        if (!server.exists()) {
            throw GradleException(
                "The phone server is not bundled. From the repository root run `pnpm mobile:bundle-server`, then build again.",
            )
        }
    }
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(checkBundledUi) }
