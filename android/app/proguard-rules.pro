# keel Android: R8 rules for the shrunk "phone" build.
# kotlinx.serialization: keep the generated serializers of keel's models (the library ships most rules itself).
-keepattributes *Annotation*, InnerClasses, Signature, EnclosingMethod
-keepclassmembers @kotlinx.serialization.Serializable class dev.keel.android.** {
    static ** Companion;
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class dev.keel.android.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class dev.keel.android.**$$serializer { *; }
# OkHttp / Okio optional platform classes
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
