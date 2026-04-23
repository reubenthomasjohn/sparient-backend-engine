# VALIDATION-10 — Admin course files

## Target functional

- [FUNCTIONAL_SPECIFICATION.md](../FUNCTIONAL_SPECIFICATION.md) §3.3.3 (cross-course file list; same principles as §3.1.1 extended with course/account context)

## Parameters

| Name | In | Required |
|------|-----|----------|
| `institution_id` | path | yes |
| `canvas_term_id` | query | no |
| `canvas_course_id` | query | no |
| `q` | query | no |
| `status` | query | no |
| `hide_replaced_in_canvas` | query | no |
| `page`, `page_size` | query | no |

## Result

- **200** items satisfy **VALIDATION-05** per-item fields **plus** `canvas_course_id`, `course_name`, `account_name`
- **Forbidden:** `comment` on items; enrollment fields

## Behavior

- Only files belonging to courses under `institution_id` appear
- Filters behave like course list (VALIDATION-05) for shared query params
- **401** / **404** / **403** as usual
