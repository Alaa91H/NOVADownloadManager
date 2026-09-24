cmake_minimum_required(VERSION 3.24)

project(NOVANative VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 6.8 REQUIRED COMPONENTS Quick QuickControls2 Network)
qt_standard_project_setup(REQUIRES 6.8)

qt_add_executable(nova-native
    src/main.cpp
    src/api/NovaApiClient.cpp
    src/api/NovaApiClient.h
    src/models/DownloadListModel.cpp
    src/models/DownloadListModel.h
)

set_source_files_properties(qml/Theme.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE)

qt_add_qml_module(nova-native
    URI Nova.Native
    VERSION 1.0
    QML_FILES
        qml/Main.qml
        qml/Theme.qml
        qml/components/NavigationRail.qml
        qml/components/CommandBar.qml
        qml/components/StatusBar.qml
        qml/pages/DownloadsPage.qml
)

target_include_directories(nova-native PRIVATE src)

target_link_libraries(nova-native
    PRIVATE
        Qt6::Quick
        Qt6::QuickControls2
        Qt6::Network
)

install(TARGETS nova-native
    BUNDLE DESTINATION .
    RUNTIME DESTINATION bin
)
