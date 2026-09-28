# Proview — existing admin design

This change extends the supplied Users page, not a redesign.

- Preserve the light gray page (#f6f7f9), white cards/drawers, navy (#1e3a5f) controls and dark (#1a1d21) text.
- Keep Instrument Serif page titles, Inter UI text, JetBrains Mono labels/roll numbers.
- Keep the fixed desktop sidebar, responsive table and pagination.
- Add a secondary Bulk reset passwords action beside Bulk upload CSV.
- Student row checkboxes, explicit page selection and a persistent selected-count bar. Selections persist across pages; changing search/section/tab clears them to prevent hidden selections.
- Reset dialog: current college, selected/all scope, server-confirmed affected count including disabled students, default temporary-password notice, mandatory acknowledgment, loading/error/success states.
- All-college scope explicitly ignores filters and includes Elite and disabled students; TPO/staff accounts never included. Require first-login password change.
- Disabled/loading controls and destructive confirmation use the current component vocabulary. Dialog is keyboard-accessible and focus-trapped.
