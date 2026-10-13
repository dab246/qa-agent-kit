# Test pack: settings and project access

Reviewed Markdown test cases are the source of truth for Phase 1.

## TC-SET-001: Administrator changes the theme from the settings page
- Type: manual-e2e
- Lane: ui
- Priority: P1
- Required: yes

### Steps
1. Sign in as an administrator.
2. Open Settings → Appearance and switch the theme.

### Expected
The new theme applies for all users after reload.

## TC-SET-002: Regular user cannot change global settings
- Type: automated
- Lane: permission
- Priority: P1
- Required: yes
- Automation: permission:settings-permissions:regular-user-update-admin-settings

## TC-PRJ-001: Users cannot open projects they do not own
- Type: automated
- Lane: permission
- Priority: P1
- Required: yes
- Automation: permission:settings-permissions:other-user-read-foreign-project
