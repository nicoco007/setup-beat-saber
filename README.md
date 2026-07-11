# Set up Beat Saber

An action that downloads and extracts Beat Saber mod dependencies using a mod's manifest file. Mods are pulled from https://beatmods.com/.
Manifest is expected to be UTF-8 encoded.

## Usage

```yaml
- name: Set up Beat Saber
  uses: nicoco007/setup-beat-saber@v1
  with:
    # The path to the project (csproj file) that will be built.
    project-path: 'MyProject/MyProject.csproj'

    # Optional. Where game assemblies and mods should be downloaded. Defaults to the runner's temporary folder.
    path: '${{ runner.temp }}\BeatSaberReferenceAssemblies'
    
    # Optional. Dictionary of dependency ID aliases. Use this if the mod ID (specified in the manifest dependencies) does not match the mod's name on BeatMods.
    aliases: '{ "MyMod": "My Mod" }'

    # Optional. Game version to use. Defaults to version specified in the manifest.
    game-version: '1.29.1'

    # Optional. Additional dependencies required for build but not at runtime (e.g. optional dependencies). These should use the mod name on BeatMods, not the mod ID.
    additional-dependencies: '{ "My Mod": "^1.2.3" }'

    # Optional. The configuration to use when fetching properties from the project. Defaults to `Release`.
    project-configuration: 'Release'
```
