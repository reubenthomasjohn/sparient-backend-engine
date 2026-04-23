# Access Hub — task specs (from technical specification)

Derived from [../TECHNICAL_SPECIFICATION.md](../TECHNICAL_SPECIFICATION.md). Each row links its **validation** spec in [../3-TaskValidationSpec/](../3-TaskValidationSpec/).

| ID | Title | Tech spec | Validation | Prerequisites |
|----|-------|-----------|------------|---------------|
| 01 | API foundation | §1, §0.1, §7.1 (initial), §7.4–7.6 | [VALIDATION-01](../3-TaskValidationSpec/VALIDATION-01-api-foundation.md) | none |
| 02 | Tenant and scope | §5.1, §7.2 | [VALIDATION-02](../3-TaskValidationSpec/VALIDATION-02-tenant-and-scope.md) | 01 |
| 03 | Domain derivations | §2, §3, §0.2–§0.3, §6.1–§6.4 | [VALIDATION-03](../3-TaskValidationSpec/VALIDATION-03-domain-derivations.md) | 01 |
| 04 | Course dashboard | §4.1, §6.7 | [VALIDATION-04](../3-TaskValidationSpec/VALIDATION-04-course-dashboard.md) | 01, 02, 03 |
| 05 | Course files list | §4.2 | [VALIDATION-05](../3-TaskValidationSpec/VALIDATION-05-course-files-list.md) | 01, 02, 03 |
| 06 | Course remediation settings | §4.3, §2 | [VALIDATION-06](../3-TaskValidationSpec/VALIDATION-06-course-remediation-settings.md) | 01, 02 |
| 07 | Course file replace | §4.4, §6.5 | [VALIDATION-07](../3-TaskValidationSpec/VALIDATION-07-course-file-replace.md) | 01, 02, 03 |
| 08 | Admin institution dashboard | §4.5, §6.6 | [VALIDATION-08](../3-TaskValidationSpec/VALIDATION-08-admin-institution-dashboard.md) | 01, 02, 03 |
| 09 | Admin scanned courses | §4.6 | [VALIDATION-09](../3-TaskValidationSpec/VALIDATION-09-admin-scanned-courses.md) | 01, 02, 03 |
| 10 | Admin course files | §4.7 | [VALIDATION-10](../3-TaskValidationSpec/VALIDATION-10-admin-course-files.md) | 01, 02, 03 |
| 11 | Admin account settings | §4.8, §2 | [VALIDATION-11](../3-TaskValidationSpec/VALIDATION-11-admin-account-settings.md) | 01, 02 |
| 12 | Signed service authentication | §5.2–§5.3, §7.1 target | [VALIDATION-12](../3-TaskValidationSpec/VALIDATION-12-signed-service-authentication.md) | 01 (optional layering with 02) |
