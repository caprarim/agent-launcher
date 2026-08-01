; Agent Launcher — Inno Setup Script
; Build with Inno Setup 6: https://jrsoftware.org/isdl.php

#define MyAppName "Agent Launcher"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Agent Launcher"
#define MyAppURL "https://your-domain.com"
#define MyAppExeName "AgentLauncher.exe"
#define MyInstallerName "AgentLauncher Installer"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir=release\installer
OutputBaseFilename={#MyInstallerName}
SetupIconFile=assets\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; Requires admin for writing to Program Files
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
; Minimum Windows version: Windows 10
MinVersion=10.0.17763
ShowLanguageDialog=no
DisableProgramGroupPage=yes
DisableWelcomePage=no
WizardSmallImageFile=assets\installer-banner-small.bmp
WizardImageFile=assets\installer-banner.bmp

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
; Include the packaged Electron app from electron-builder output
Source: "release\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;
