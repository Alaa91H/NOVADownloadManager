cmake_minimum_required(VERSION 3.24)

project(NOVANative VERSION 2.4.48 LANGUAGES CXX)

set(NOVA_APP_VERSION "2.4.48-alpha")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(NOVA_BUILD_TESTS "Build native Qt stress/recovery tests" OFF)

find_package(Qt6 6.8 REQUIRED COMPONENTS Quick QuickControls2 Network Widgets)
if(UNIX AND NOT APPLE)
    find_package(Qt6 6.8 REQUIRED COMPONENTS DBus)
endif()
qt_standard_project_setup(REQUIRES 6.8)

qt_add_executable(nova-native
    src/main.cpp
    src/api/NovaApiClient.cpp
    src/api/NovaApiClient.h
    src/batch/BatchPatternExpander.cpp
    src/batch/BatchPatternExpander.h
    src/models/DownloadListModel.cpp
    src/models/DownloadListModel.h
    src/localization/I18nManager.cpp
    src/localization/I18nManager.h
    src/platform/AppearanceManager.cpp
    src/platform/AppearanceManager.h
    src/platform/BackendBootstrap.cpp
    src/platform/BackendBootstrap.h
    src/platform/ClipboardMonitor.cpp
    src/platform/ClipboardMonitor.h
    src/platform/DesktopIntegration.cpp
    src/platform/DesktopIntegration.h
    src/platform/TrayManager.cpp
    src/platform/TrayManager.h
    src/platform/UpdaterManager.cpp
    src/platform/UpdaterManager.h
    src/settings/NativeSettings.cpp
    src/settings/NativeSettings.h
)

set_source_files_properties(qml/Theme.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE)

qt_add_qml_module(nova-native
    URI Nova.Native
    VERSION 1.0
    QML_FILES
        qml/Main.qml
        qml/Theme.qml
        qml/components/AddDownloadDialog.qml
        qml/components/BrowserIntegrationPanel.qml
        qml/components/CommandBar.qml
        qml/components/CustomizationPanel.qml
        qml/components/ConfirmDeleteDialog.qml
        qml/components/ConfirmRedownloadDialog.qml
        qml/components/DownloadDetailsPanel.qml
        qml/components/DownloadPropertiesDialog.qml
        qml/components/MediaAdvancedPanel.qml
        qml/components/QueueSettingsPanel.qml
        qml/components/QueueSchedulerPanel.qml
        qml/components/SettingsAdvancedPanel.qml
        qml/components/NavigationRail.qml
        qml/components/StatusBar.qml
        qml/pages/BatchImportPage.qml
        qml/pages/DownloadsPage.qml
        qml/pages/LinkGrabberPage.qml
        qml/pages/MediaDownloaderPage.qml
        qml/pages/QueuePage.qml
        qml/pages/SchedulerPage.qml
        qml/pages/SettingsPage.qml
)

target_include_directories(nova-native PRIVATE src)
target_compile_definitions(nova-native PRIVATE NOVA_NATIVE_VERSION="${NOVA_APP_VERSION}")

if(APPLE)
    enable_language(OBJCXX)
    target_sources(nova-native PRIVATE
        src/platform/MacDockProgress.mm
        resources/icons/icon.icns
    )
    set_source_files_properties(
        resources/icons/icon.icns
        PROPERTIES
            MACOSX_PACKAGE_LOCATION "Resources"
    )
    set_source_files_properties(
        src/platform/MacDockProgress.mm
        PROPERTIES
            COMPILE_FLAGS "-fobjc-arc"
    )
    find_library(COCOA_FRAMEWORK Cocoa REQUIRED)
    target_link_libraries(nova-native PRIVATE ${COCOA_FRAMEWORK})

    set_target_properties(nova-native PROPERTIES
        MACOSX_BUNDLE TRUE
        MACOSX_BUNDLE_GUI_IDENTIFIER "com.nova.downloadmanager"
        MACOSX_BUNDLE_BUNDLE_NAME "NOVA Download Manager"
        MACOSX_BUNDLE_ICON_FILE "icon.icns"
        MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
        MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
    )
endif()

target_link_libraries(nova-native
    PRIVATE
        Qt6::Quick
        Qt6::QuickControls2
        Qt6::Network
        Qt6::Widgets
)

if(UNIX AND NOT APPLE)
    target_link_libraries(nova-native PRIVATE Qt6::DBus)
endif()

if(WIN32)
    target_sources(nova-native PRIVATE resources/nova-native.rc)
    target_link_libraries(nova-native PRIVATE ole32 uuid advapi32)
endif()


if(NOVA_BUILD_TESTS)
    enable_testing()
    find_package(Qt6 6.8 REQUIRED COMPONENTS Test)

    qt_add_executable(nova-native-tests
        tests/NativeParityTests.cpp
        src/api/NovaApiClient.cpp
        src/api/NovaApiClient.h
        src/batch/BatchPatternExpander.cpp
        src/batch/BatchPatternExpander.h
        src/models/DownloadListModel.cpp
        src/models/DownloadListModel.h
        src/localization/I18nManager.cpp
        src/localization/I18nManager.h
        src/settings/NativeSettings.cpp
        src/settings/NativeSettings.h
    )

    target_include_directories(nova-native-tests PRIVATE src)
    target_link_libraries(nova-native-tests
        PRIVATE
            Qt6::Network
            Qt6::Test
    )

    add_test(
        NAME nova-native-parity
        COMMAND nova-native-tests -o -,txt
    )
    set_tests_properties(
        nova-native-parity
        PROPERTIES
            TIMEOUT 30
    )

    qt_add_executable(nova-native-display-tests
        tests/DisplayScaleTests.cpp
    )
    target_link_libraries(nova-native-display-tests
        PRIVATE
            Qt6::Gui
            Qt6::Test
    )

    add_test(
        NAME nova-native-display-scale-125
        COMMAND nova-native-display-tests -o -,txt
    )
    set_tests_properties(
        nova-native-display-scale-125
        PROPERTIES
            TIMEOUT 20
            ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_SCALE_FACTOR=1.25;NOVA_EXPECT_SCALE_FACTOR=1.25"
    )

    add_test(
        NAME nova-native-display-scale-200
        COMMAND nova-native-display-tests -o -,txt
    )
    set_tests_properties(
        nova-native-display-scale-200
        PROPERTIES
            TIMEOUT 20
            ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_SCALE_FACTOR=2.0;NOVA_EXPECT_SCALE_FACTOR=2.0"
    )
endif()

install(TARGETS nova-native
    BUNDLE DESTINATION .
    RUNTIME DESTINATION bin
)

if(UNIX AND NOT APPLE)
    install(
        FILES resources/nova-native.desktop
        DESTINATION share/applications
    )
    install(
        FILES resources/icons/128x128.png
        DESTINATION share/icons/hicolor/128x128/apps
        RENAME nova-download-manager.png
    )
endif()
