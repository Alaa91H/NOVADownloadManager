# NOVA Download Manager Android companion
#
# Android Gradle Plugin always loads this project file for release minification.
# Keep Manifest-instantiated components explicit so a future library or
# dependency change cannot remove application entry points during shrinking.

-keep class com.nova.downloadmanager.app.MainActivity { *; }
-keep class com.nova.downloadmanager.app.NovaApplication { *; }
-keep class com.nova.downloadmanager.service.NovaUserInitiatedTransferJobService { *; }

# Preserve names for AndroidX Startup and WorkManager entries supplied through
# the Manifest/configuration provider. No transfer implementation is kept here;
# the Kotlin layer remains an Android boundary around the shared NOVA core.
-keepnames class androidx.startup.**
-keepnames class androidx.work.**
