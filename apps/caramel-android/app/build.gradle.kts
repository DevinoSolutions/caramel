plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing comes from the environment (the release workflow writes the
// upload keystore to a temp file and exports these). Absent = the release build
// is left UNSIGNED and the workflow's own secret check is what fails loudly.
val releaseKeystorePath: String? = System.getenv("CARAMEL_KEYSTORE_PATH")

android {
    namespace = "com.devino.caramel"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.devino.caramel"
        minSdk = 26
        targetSdk = 36
        // 1.6.0 = the WebView shell (T-7842); Android has its own version line, the iOS container (project.yml MARKETING_VERSION) is 1.6.0 too, but the two lines are versioned independently.
        // The release workflow passes -PcaramelVersionCode = 100 + run number. TODO(T-7474): no
        // Gradle dependency locking / verification-metadata.xml yet (supply-chain pinning of the
        // resolved artifacts); add it once the dependency set settles.
        versionCode = (project.findProperty("caramelVersionCode") as String?)?.toInt() ?: 1
        // T-7852 (web-session handoff) is wired: the Saved and Account tabs get a web session through
        // POST /api/app/web-session/handoff. It has had no device sign-in run yet; do that before tagging android-v1.6.0.
        versionName = "1.6.0"

        // The origin every call and the WebView go to (AppConfig.API_BASE_URL / WEBSITE_URL, AppLinkGuard.APP_ORIGIN).
        // debug and release are production; ONLY the devproof build type below overrides it.
        buildConfigField("String", "API_BASE_URL", "\"https://grabcaramel.com\"")
        // True ONLY in the devproof build type. Every dev-proof code path is guarded by it so R8 strips it from release.
        buildConfigField("boolean", "DEV_PROOF", "false")
    }

    signingConfigs {
        if (releaseKeystorePath != null) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = System.getenv("CARAMEL_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("CARAMEL_KEY_ALIAS")
                keyPassword = System.getenv("CARAMEL_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseKeystorePath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }

        // T-9413: DEV-ONLY proof build, never shipped. It is `release` (same R8 and resource shrinking, so a walk on it
        // proves the SHRUNK build) except that it: installs beside the store app (applicationIdSuffix), is signed with the
        // debug key and NEVER the upload key, talks to dev.grabcaramel.com, and accepts a session bearer through the
        // `devproof_session` intent extra (core/DevProofSession.kt) because the app signs in with Google/Apple only and
        // no throwaway external accounts are allowed. A build TYPE, not a flavor, on purpose: a flavor dimension would
        // rename the release tasks and outputs (assembleXxxRelease, outputs/bundle/xxxRelease) that release-android-app.yml
        // calls by name. Nothing in .github/workflows/release-android-app.yml may mention it (the vitest
        // tests/unit/android-devproof-never-ships.test.ts and the android-devproof-guard workflow enforce that).
        // Written after `release` so initWith copies the finished release config.
        create("devproof") {
            initWith(getByName("release"))
            applicationIdSuffix = ".devproof"
            signingConfig = signingConfigs.getByName("debug")
            buildConfigField("String", "API_BASE_URL", "\"https://dev.grabcaramel.com\"")
            buildConfigField("boolean", "DEV_PROOF", "true")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        warningsAsErrors = false
        abortOnError = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }
}

// The devproof build type is built and shrunk, not unit-tested: the unit tests pin the production origin literally.
tasks.matching { it.name == "testDevproofUnitTest" }.configureEach { enabled = false }

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.browser)
    // Pins the transitive androidx.fragment (old, via Play services) past 1.3.0: AGP 9 lint InvalidFragmentVersionForActivityResult.
    implementation(libs.androidx.fragment)
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services.auth)
    implementation(libs.googleid)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
