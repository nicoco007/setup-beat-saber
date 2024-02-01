# Set up Beat Saber

An action that downloads and extracts Beat Saber mod dependencies using a mod's manifest file. Mods are pulled from https://beatmods.com/.
Manifest is expected to be UTF-8 encoded.

## Usage

```yaml
- name: Set up Beat Saber
  uses: nicoco007/setup-beat-saber@main
  with:
    access-token: github_pat_whatever
    # (Optional) manifest location
    manifest: ${{github.workspace}}/manifest.json
    # (Optional) extract location
    path: ${{github.workspace}}/Refs
    # (Optional) aliased dependencies
    aliases: '{"mod id": "beatmods name"}'
```
