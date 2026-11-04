# kotlinx.serialization: keep the generated serializers of the wire models.
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class com.devino.caramel.core.**$$serializer { *; }
-keepclassmembers class com.devino.caramel.core.** {
    *** Companion;
}
-keepclasseswithmembers class com.devino.caramel.core.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Credential Manager finds its Play Services provider by reflection (androidx.credentials docs).
-if class androidx.credentials.CredentialManager
-keep class androidx.credentials.playservices.** {
  *;
}
