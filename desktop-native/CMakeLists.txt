cmake_minimum_required(VERSION 3.24)

project(NOVANative VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 6.8 REQUIRED COMPONENTS Quick QuickControls2 Network Widgets)
qt_standard_project_setup(REQUIRES 6.8)

qt_add_executable(nova-native
    src/main.cpp
    src/api/NovaApiClient.cpp
    src/api/NovaApiClient.h
    src/models/DownloadListModel.cpp
    src/models/DownloadListModel.h
    src/platform/DesktopIntegration.cpp
    src/platform/DesktopIntegration.h
    src/platform/TrayManager.cpp
    src/platform/TrayManager.h
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
        qml/components/CommandBar.qml
        qml/components/ConfirmDeleteDialog.qml
        qml/components/ConfirmRedownloadDialog.qml
        qml/components/DownloadDetailsPanel.qml
        qml/components/DownloadPropertiesDialog.qml
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

target_link_libraries(nova-native
    PRIVATE
        Qt6::Quick
        Qt6::QuickControls2
        Qt6::Network
        Qt6::Widgets
)

install(TARGETS nova-native
    BUNDLE DESTINATION .
    RUNTIME DESTINATION bin
)
