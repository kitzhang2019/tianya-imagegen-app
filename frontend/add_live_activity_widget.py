#!/usr/bin/env python3
"""Add a Widget Extension target (LiveActivityWidget) to the Capacitor iOS project.

This script modifies frontend/ios/App/App.xcodeproj/project.pbxproj to add:
  - A PBXNativeTarget "LiveActivityWidget" (product type app-extension)
  - Build phases (Sources / Frameworks / Resources) for the extension
  - Build files + file references for LiveActivityWidget.swift and
    LiveActivityManager.swift (shared with the plugin) and the extension Info.plist
  - An "Embed App Extensions" copy phase on the main App target
  - A target dependency from App to LiveActivityWidget
  - Debug/Release build configurations for the extension
  - The extension product (.appex) in the Products group and the project targets list

It is idempotent: running it twice does not duplicate the target.

Usage: python3 add_live_activity_widget.py
Run from the repo root (tianya-imagegen-app/) or anywhere; paths are resolved
relative to this script's location (frontend/ios/App/App.xcodeproj/).
"""

import re
import secrets
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
# The script lives in frontend/ (next to ios/). Adjust if moved.
FRONTEND_DIR = SCRIPT_DIR
PBXPROJ = FRONTEND_DIR / "ios" / "App" / "App.xcodeproj" / "project.pbxproj"

EXT_NAME = "LiveActivityWidget"
EXT_BUNDLE_ID = "com.tianya.imagegen.LiveActivityWidget"


def new_uuid():
    """Xcode-style 24-char hex UUID."""
    return secrets.token_hex(12).upper()


def read_pbxproj():
    return PBXPROJ.read_text(encoding="utf-8")


def write_pbxproj(text):
    PBXPROJ.write_text(text, encoding="utf-8")


def main():
    text = read_pbxproj()
    if "LiveActivityWidget" in text:
        print("LiveActivityWidget already present in project.pbxproj - nothing to do.")
        return 0

    # --- Generate UUIDs for every new object ---
    u = {name: new_uuid() for name in [
        "ext_target",            # PBXNativeTarget
        "ext_build_config_list",  # XCConfigurationList
        "ext_debug_config",      # XCBuildConfiguration Debug
        "ext_release_config",    # XCBuildConfiguration Release
        "ext_sources_phase",     # PBXSourcesBuildPhase
        "ext_frameworks_phase",  # PBXFrameworksBuildPhase
        "ext_resources_phase",   # PBXResourcesBuildPhase
        "ext_group",             # PBXGroup LiveActivityWidget
        "ext_product_ref",       # PBXFileReference .appex
        "ext_swift_widget_ref",  # PBXFileReference LiveActivityWidget.swift
        "ext_swift_manager_ref",  # PBXFileReference LiveActivityManager.swift
        "ext_infoplist_ref",     # PBXFileReference Info.plist
        "ext_swift_widget_build",  # PBXBuildFile widget swift in Sources
        "ext_swift_manager_build",  # PBXBuildFile manager swift in Sources
        "ext_appex_build",       # PBXBuildFile .appex in Embed App Extensions
        "ext_embed_phase",       # PBXCopyFilesBuildPhase (Embed App Extensions)
        "ext_dependency",        # PBXTargetDependency App -> LiveActivityWidget
        "ext_dependency_proxy",  # PBXContainerItemProxy for the dependency
    ]}

    # --- 1. PBXBuildFile section: add extension sources + appex embed ---
    buildfile_entries = (
        f"\t\t{u['ext_swift_widget_build']} /* LiveActivityWidget.swift in Sources */ = {{isa = PBXBuildFile; fileRef = {u['ext_swift_widget_ref']} /* LiveActivityWidget.swift */; }};\n"
        f"\t\t{u['ext_swift_manager_build']} /* LiveActivityManager.swift in Sources */ = {{isa = PBXBuildFile; fileRef = {u['ext_swift_manager_ref']} /* LiveActivityManager.swift */; }};\n"
        f"\t\t{u['ext_appex_build']} /* LiveActivityWidget.appex in Embed App Extensions */ = {{isa = PBXBuildFile; fileRef = {u['ext_product_ref']} /* LiveActivityWidget.appex */; settings = {{ATTRIBUTES = (RemoveHeadersOnCopy, ); }}; }};\n"
    )
    text = text.replace(
        "/* End PBXBuildFile section */",
        buildfile_entries + "/* End PBXBuildFile section */",
        1,
    )

    # --- 2. PBXFileReference section: extension files + .appex product ---
    fileref_entries = (
        f"\t\t{u['ext_product_ref']} /* LiveActivityWidget.appex */ = {{isa = PBXFileReference; explicitFileType = \"wrapper.app-extension\"; includeInIndex = 0; path = LiveActivityWidget.appex; sourceTree = BUILT_PRODUCTS_DIR; }};\n"
        f"\t\t{u['ext_swift_widget_ref']} /* LiveActivityWidget.swift */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = LiveActivityWidget.swift; sourceTree = \"<group>\"; }};\n"
        f"\t\t{u['ext_swift_manager_ref']} /* LiveActivityManager.swift */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = LiveActivityManager.swift; sourceTree = \"<group>\"; }};\n"
        f"\t\t{u['ext_infoplist_ref']} /* Info.plist */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = \"<group>\"; }};\n"
    )
    text = text.replace(
        "/* End PBXFileReference section */",
        fileref_entries + "/* End PBXFileReference section */",
        1,
    )

    # --- 3. PBXCopyFilesBuildPhase: "Embed App Extensions" on the App target ---
    copyfiles_entry = (
        f"\t\t{u['ext_embed_phase']} /* Embed App Extensions */ = {{\n"
        f"\t\t\tisa = PBXCopyFilesBuildPhase;\n"
        f"\t\t\tbuildActionMask = 2147483647;\n"
        f"\t\t\tdstPath = \"\";\n"
        f"\t\t\tdstSubfolderSpec = 13;\n"
        f"\t\t\tfiles = (\n"
        f"\t\t\t\t{u['ext_appex_build']} /* LiveActivityWidget.appex in Embed App Extensions */,\n"
        f"\t\t\t);\n"
        f"\t\t\tname = \"Embed App Extensions\";\n"
        f"\t\t\trunOnlyForDeploymentPostprocessing = 0;\n"
        f"\t\t}};\n"
    )
    # Insert the new section right before the PBXFileReference section header
    # (sections are alphabetical: PBXBuildFile, PBXContainerItemProxy,
    #  PBXCopyFilesBuildPhase, PBXFileReference, ...). If there is no
    #  PBXContainerItemProxy section yet, insert before PBXFileReference.
    marker = "/* Begin PBXFileReference section */"
    text = text.replace(marker, "/* Begin PBXCopyFilesBuildPhase section */\n" + copyfiles_entry + "/* End PBXCopyFilesBuildPhase section */\n\n" + marker, 1)

    # --- 4. PBXContainerItemProxy + PBXTargetDependency (App -> extension) ---
    proxy_entry = (
        f"\t\t{u['ext_dependency_proxy']} /* PBXContainerItemProxy */ = {{\n"
        f"\t\t\tisa = PBXContainerItemProxy;\n"
        f"\t\t\tcontainerPortal = 504EC2FC1FED79650016851F /* Project object */;\n"
        f"\t\t\tproxyType = 1;\n"
        f"\t\t\tremoteGlobalIDString = {u['ext_target']};\n"
        f"\t\t\tremoteInfo = LiveActivityWidget;\n"
        f"\t\t}};\n"
    )
    dep_entry = (
        f"\t\t{u['ext_dependency']} /* PBXTargetDependency */ = {{\n"
        f"\t\t\tisa = PBXTargetDependency;\n"
        f"\t\t\ttarget = {u['ext_target']} /* LiveActivityWidget */;\n"
        f"\t\t\ttargetProxy = {u['ext_dependency_proxy']} /* PBXContainerItemProxy */;\n"
        f"\t\t}};\n"
    )
    # ContainerItemProxy section goes right before CopyFiles (alphabetical).
    marker = "/* Begin PBXCopyFilesBuildPhase section */"
    text = text.replace(
        marker,
        "/* Begin PBXContainerItemProxy section */\n" + proxy_entry + "/* End PBXContainerItemProxy section */\n\n"
        "/* Begin PBXTargetDependency section */\n" + dep_entry + "/* End PBXTargetDependency section */\n\n" + marker,
        1,
    )

    # --- 5. PBXFrameworksBuildPhase for the extension ---
    fw_entry = (
        f"\t\t{u['ext_frameworks_phase']} /* Frameworks */ = {{\n"
        f"\t\t\tisa = PBXFrameworksBuildPhase;\n"
        f"\t\t\tbuildActionMask = 2147483647;\n"
        f"\t\t\tfiles = (\n"
        f"\t\t\t);\n"
        f"\t\t\trunOnlyForDeploymentPostprocessing = 0;\n"
        f"\t\t}};\n"
    )
    text = text.replace(
        "/* End PBXFrameworksBuildPhase section */",
        fw_entry + "/* End PBXFrameworksBuildPhase section */",
        1,
    )

    # --- 6. PBXGroup: extension group + add .appex to Products ---
    group_entry = (
        f"\t\t{u['ext_group']} /* LiveActivityWidget */ = {{\n"
        f"\t\t\tisa = PBXGroup;\n"
        f"\t\t\tchildren = (\n"
        f"\t\t\t\t{u['ext_swift_widget_ref']} /* LiveActivityWidget.swift */,\n"
        f"\t\t\t\t{u['ext_swift_manager_ref']} /* LiveActivityManager.swift */,\n"
        f"\t\t\t\t{u['ext_infoplist_ref']} /* Info.plist */,\n"
        f"\t\t\t);\n"
        f"\t\t\tpath = LiveActivityWidget;\n"
        f"\t\t\tsourceTree = \"<group>\";\n"
        f"\t\t}};\n"
    )
    text = text.replace(
        "/* End PBXGroup section */",
        group_entry + "/* End PBXGroup section */",
        1,
    )
    # Add the extension group to the top-level group children (next to App group)
    text = text.replace(
        "\t\t\t\t504EC3061FED79650016851F /* App */,\n",
        "\t\t\t\t504EC3061FED79650016851F /* App */,\n"
        f"\t\t\t\t{u['ext_group']} /* LiveActivityWidget */,\n",
        1,
    )
    # Add the .appex to the Products group children
    text = text.replace(
        "\t\t\t\t504EC3041FED79650016851F /* App.app */,\n",
        "\t\t\t\t504EC3041FED79650016851F /* App.app */,\n"
        f"\t\t\t\t{u['ext_product_ref']} /* LiveActivityWidget.appex */,\n",
        1,
    )

    # --- 7. PBXNativeTarget for the extension ---
    target_entry = (
        f"\t\t{u['ext_target']} /* LiveActivityWidget */ = {{\n"
        f"\t\t\tisa = PBXNativeTarget;\n"
        f"\t\t\tbuildConfigurationList = {u['ext_build_config_list']} /* Build configuration list for PBXNativeTarget \"LiveActivityWidget\" */;\n"
        f"\t\t\tbuildPhases = (\n"
        f"\t\t\t\t{u['ext_sources_phase']} /* Sources */,\n"
        f"\t\t\t\t{u['ext_frameworks_phase']} /* Frameworks */,\n"
        f"\t\t\t\t{u['ext_resources_phase']} /* Resources */,\n"
        f"\t\t\t);\n"
        f"\t\t\tbuildRules = (\n"
        f"\t\t\t);\n"
        f"\t\t\tdependencies = (\n"
        f"\t\t\t);\n"
        f"\t\t\tname = LiveActivityWidget;\n"
        f"\t\t\tproductName = LiveActivityWidget;\n"
        f"\t\t\tproductReference = {u['ext_product_ref']} /* LiveActivityWidget.appex */;\n"
        f"\t\t\tproductType = \"com.apple.product-type.app-extension\";\n"
        f"\t\t}};\n"
    )
    text = text.replace(
        "/* End PBXNativeTarget section */",
        target_entry + "/* End PBXNativeTarget section */",
        1,
    )

    # --- 8. PBXProject: add extension to targets + TargetAttributes ---
    text = text.replace(
        "\t\t\ttargets = (\n\t\t\t\t504EC3031FED79650016851F /* App */,\n\t\t\t);\n",
        "\t\t\ttargets = (\n\t\t\t\t504EC3031FED79650016851F /* App */,\n"
        f"\t\t\t\t{u['ext_target']} /* LiveActivityWidget */,\n\t\t\t);\n",
        1,
    )
    text = text.replace(
        "\t\t\t\t\t504EC3031FED79650016851F = {\n\t\t\t\t\t\tCreatedOnToolsVersion = 9.2;\n\t\t\t\t\t\tLastSwiftMigration = 1100;\n\t\t\t\t\t\tProvisioningStyle = Automatic;\n\t\t\t\t\t};\n",
        "\t\t\t\t\t504EC3031FED79650016851F = {\n\t\t\t\t\t\tCreatedOnToolsVersion = 9.2;\n\t\t\t\t\t\tLastSwiftMigration = 1100;\n\t\t\t\t\t\tProvisioningStyle = Automatic;\n\t\t\t\t\t};\n"
        f"\t\t\t\t\t{u['ext_target']} = {{\n"
        f"\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;\n"
        f"\t\t\t\t\t\tProvisioningStyle = Automatic;\n"
        f"\t\t\t\t\t}};\n",
        1,
    )

    # --- 9. App target: add Embed App Extensions phase + dependency ---
    text = text.replace(
        "\t\t\tbuildPhases = (\n\t\t\t\t504EC3001FED79650016851F /* Sources */,\n\t\t\t\t504EC3011FED79650016851F /* Frameworks */,\n\t\t\t\t504EC3021FED79650016851F /* Resources */,\n\t\t\t);\n",
        "\t\t\tbuildPhases = (\n\t\t\t\t504EC3001FED79650016851F /* Sources */,\n\t\t\t\t504EC3011FED79650016851F /* Frameworks */,\n\t\t\t\t504EC3021FED79650016851F /* Resources */,\n"
        f"\t\t\t\t{u['ext_embed_phase']} /* Embed App Extensions */,\n\t\t\t);\n",
        1,
    )
    text = text.replace(
        "\t\t\tdependencies = (\n\t\t\t);\n\t\t\tname = App;",
        "\t\t\tdependencies = (\n"
        f"\t\t\t\t{u['ext_dependency']} /* PBXTargetDependency */,\n\t\t\t);\n\t\t\tname = App;",
        1,
    )

    # --- 10. PBXResourcesBuildPhase + PBXSourcesBuildPhase for the extension ---
    res_entry = (
        f"\t\t{u['ext_resources_phase']} /* Resources */ = {{\n"
        f"\t\t\tisa = PBXResourcesBuildPhase;\n"
        f"\t\t\tbuildActionMask = 2147483647;\n"
        f"\t\t\tfiles = (\n"
        f"\t\t\t);\n"
        f"\t\t\trunOnlyForDeploymentPostprocessing = 0;\n"
        f"\t\t}};\n"
    )
    text = text.replace(
        "/* End PBXResourcesBuildPhase section */",
        res_entry + "/* End PBXResourcesBuildPhase section */",
        1,
    )
    src_entry = (
        f"\t\t{u['ext_sources_phase']} /* Sources */ = {{\n"
        f"\t\t\tisa = PBXSourcesBuildPhase;\n"
        f"\t\t\tbuildActionMask = 2147483647;\n"
        f"\t\t\tfiles = (\n"
        f"\t\t\t\t{u['ext_swift_widget_build']} /* LiveActivityWidget.swift in Sources */,\n"
        f"\t\t\t\t{u['ext_swift_manager_build']} /* LiveActivityManager.swift in Sources */,\n"
        f"\t\t\t);\n"
        f"\t\t\trunOnlyForDeploymentPostprocessing = 0;\n"
        f"\t\t}};\n"
    )
    text = text.replace(
        "/* End PBXSourcesBuildPhase section */",
        src_entry + "/* End PBXSourcesBuildPhase section */",
        1,
    )

    # --- 11. XCBuildConfiguration for the extension (Debug + Release) ---
    debug_config = (
        f"\t\t{u['ext_debug_config']} /* Debug */ = {{\n"
        f"\t\t\tisa = XCBuildConfiguration;\n"
        f"\t\t\tbuildSettings = {{\n"
        f"\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;\n"
        f"\t\t\t\tASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS = YES;\n"
        f"\t\t\t\tCLANG_ANALYZER_NONNULL = YES;\n"
        f"\t\t\t\tCLANG_ENABLE_MODULES = YES;\n"
        f"\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;\n"
        f"\t\t\t\tCODE_SIGN_STYLE = Automatic;\n"
        f"\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n"
        f"\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;\n"
        f"\t\t\t\tGCC_NO_COMMON_BLOCKS = YES;\n"
        f"\t\t\t\tINFOPLIST_FILE = LiveActivityWidget/Info.plist;\n"
        f"\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 16.2;\n"
        f"\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (\n"
        f"\t\t\t\t\t\"$(inherited)\",\n"
        f"\t\t\t\t\t\"@executable_path/Frameworks\",\n"
        f"\t\t\t\t\t\"@executable_path/../../Frameworks\",\n"
        f"\t\t\t\t);\n"
        f"\t\t\t\tMARKETING_VERSION = 1.0;\n"
        f"\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = {EXT_BUNDLE_ID};\n"
        f"\t\t\t\tPRODUCT_NAME = \"$(TARGET_NAME)\";\n"
        f"\t\t\t\tSDKROOT = iphoneos;\n"
        f"\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;\n"
        f"\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = \"-Onone\";\n"
        f"\t\t\t\tSWIFT_VERSION = 5.0;\n"
        f"\t\t\t\tTARGETED_DEVICE_FAMILY = \"1,2\";\n"
        f"\t\t\t}};\n"
        f"\t\t\tname = Debug;\n"
        f"\t\t}};\n"
    )
    release_config = (
        f"\t\t{u['ext_release_config']} /* Release */ = {{\n"
        f"\t\t\tisa = XCBuildConfiguration;\n"
        f"\t\t\tbuildSettings = {{\n"
        f"\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;\n"
        f"\t\t\t\tASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS = YES;\n"
        f"\t\t\t\tCLANG_ANALYZER_NONNULL = YES;\n"
        f"\t\t\t\tCLANG_ENABLE_MODULES = YES;\n"
        f"\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;\n"
        f"\t\t\t\tCODE_SIGN_STYLE = Automatic;\n"
        f"\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n"
        f"\t\t\t\tDEBUG_INFORMATION_FORMAT = \"dwarf-with-dsym\";\n"
        f"\t\t\t\tENABLE_NS_ASSERTIONS = NO;\n"
        f"\t\t\t\tGCC_NO_COMMON_BLOCKS = YES;\n"
        f"\t\t\t\tINFOPLIST_FILE = LiveActivityWidget/Info.plist;\n"
        f"\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 16.2;\n"
        f"\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (\n"
        f"\t\t\t\t\t\"$(inherited)\",\n"
        f"\t\t\t\t\t\"@executable_path/Frameworks\",\n"
        f"\t\t\t\t\t\"@executable_path/../../Frameworks\",\n"
        f"\t\t\t\t);\n"
        f"\t\t\t\tMARKETING_VERSION = 1.0;\n"
        f"\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = {EXT_BUNDLE_ID};\n"
        f"\t\t\t\tPRODUCT_NAME = \"$(TARGET_NAME)\";\n"
        f"\t\t\t\tSDKROOT = iphoneos;\n"
        f"\t\t\t\tSWIFT_COMPILATION_MODE = wholemodule;\n"
        f"\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = \"-O\";\n"
        f"\t\t\t\tSWIFT_VERSION = 5.0;\n"
        f"\t\t\t\tTARGETED_DEVICE_FAMILY = \"1,2\";\n"
        f"\t\t\t\tVALIDATE_PRODUCT = YES;\n"
        f"\t\t\t}};\n"
        f"\t\t\tname = Release;\n"
        f"\t\t}};\n"
    )
    text = text.replace(
        "/* End XCBuildConfiguration section */",
        debug_config + release_config + "/* End XCBuildConfiguration section */",
        1,
    )

    # --- 12. XCConfigurationList for the extension ---
    config_list = (
        f"\t\t{u['ext_build_config_list']} /* Build configuration list for PBXNativeTarget \"LiveActivityWidget\" */ = {{\n"
        f"\t\t\tisa = XCConfigurationList;\n"
        f"\t\t\tbuildConfigurations = (\n"
        f"\t\t\t\t{u['ext_debug_config']} /* Debug */,\n"
        f"\t\t\t\t{u['ext_release_config']} /* Release */,\n"
        f"\t\t\t);\n"
        f"\t\t\tdefaultConfigurationIsVisible = 0;\n"
        f"\t\t\tdefaultConfigurationName = Release;\n"
        f"\t\t}};\n"
    )
    text = text.replace(
        "/* End XCConfigurationList section */",
        config_list + "/* End XCConfigurationList section */",
        1,
    )

    write_pbxproj(text)
    print("Added LiveActivityWidget target to project.pbxproj.")
    print("UUIDs used:")
    for k, v in u.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
