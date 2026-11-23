import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val releaseSigningInputs = listOf("KEYSTORE", "STORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD")
    .associateWith { providers.environmentVariable("MUSICDECK_ANDROID_$it").orNull?.takeIf { value -> value.isNotBlank() } }
val signRelease = releaseSigningInputs.values.any { it != null }
if (signRelease) {
    val missing = releaseSigningInputs.filterValues { it == null }.keys
    require(missing.isEmpty()) { "Missing Android release signing settings: ${missing.joinToString { "MUSICDECK_ANDROID_$it" }}" }
}

android {
    compileSdk = 37
    ndkVersion = "29.0.13846066"
    namespace = "app.musicdeck.android"
    defaultConfig {
        applicationId = "app.musicdeck.android"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    if (signRelease) {
        signingConfigs.create("musicdeckRelease") {
            storeFile = file(releaseSigningInputs.getValue("KEYSTORE")!!)
            storePassword = releaseSigningInputs.getValue("STORE_PASSWORD")
            keyAlias = releaseSigningInputs.getValue("KEY_ALIAS")
            keyPassword = releaseSigningInputs.getValue("KEY_PASSWORD")
        }
    }
    buildTypes {
        getByName("debug") {
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (signRelease) signingConfig = signingConfigs.getByName("musicdeckRelease")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
