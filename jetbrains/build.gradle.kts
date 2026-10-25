import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.2.21"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.2.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.keel"
version = providers.gradleProperty("pluginVersion").get()

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        // 2024.3 ships the Kotlin 2.0 standard library: use nothing newer
        apiVersion.set(KotlinVersion.KOTLIN_2_0)
        languageVersion.set(KotlinVersion.KOTLIN_2_0)
        // the platform's interfaces have JVM default methods: do not copy them into our classes (the verifier would
        // see overrides of internal and deprecated members)
        jvmDefault.set(JvmDefaultMode.NO_COMPATIBILITY)
    }
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        create(IntelliJPlatformType.IntellijIdeaCommunity, "2024.3")
        bundledPlugin("Git4Idea")
        pluginVerifier()
        testFramework(TestFrameworkType.Platform)
    }
    // the IDE brings Kotlin and kotlinx.coroutines; keep them out of the plugin
    implementation("com.squareup.okhttp3:okhttp:4.12.0") { exclude(group = "org.jetbrains.kotlin") }
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0") { exclude(group = "org.jetbrains.kotlin") }
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3") {
        exclude(group = "org.jetbrains.kotlin")
    }
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.opentest4j:opentest4j:1.3.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0") { exclude(group = "org.jetbrains.kotlin") }
}

intellijPlatform {
    projectName = "keel-jetbrains"
    buildSearchableOptions = false
    instrumentCode = false
    pluginConfiguration {
        id = "dev.keel.jetbrains"
        name = "keel"
        version = project.version.toString()
        vendor {
            name = "keel"
        }
        ideaVersion {
            sinceBuild = "243"
            untilBuild = provider { null }
        }
    }
    pluginVerification {
        ides {
            create(IntelliJPlatformType.IntellijIdeaCommunity, "2024.3")
        }
    }
}

tasks.test {
    useJUnit()
}
