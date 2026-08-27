# NOVA Download Manager Android companion
#
# Android Gradle Plugin always loads this project file for release minification.
# Keep Manifest-instantiated components explicit so a future library or
# dependency change cannot remove application entry points during shrinking.

-keep class com.nova.downloadmanager.app.MainActivity { *; }
-keep class com.nova.downloadmanager.service.NovaUserInitiatedTransferJobService { *; }
