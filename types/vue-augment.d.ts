/**
 * Vue type augmentations that let `vueCompilerOptions.strictTemplates` be on.
 *
 * `aria-*` is a native HTML attribute namespace, not a component prop. With
 * `strictTemplates` enabled, `vue-tsc` treats `aria-label="…"` on a component as
 * an unknown **prop** and errors — but only for `aria-*`: a genuinely camelCase
 * prop like `menu-placement` → `menuPlacement` maps fine on the same component.
 * So the failure is specific to Vue's handling of the `aria-*` namespace, and the
 * fix belongs here rather than in the call sites.
 *
 * Declaring a `ariaLabel` prop instead does silence it, but it makes the tooling
 * shape the API: the call sites would have to abandon the idiomatic `aria-label`
 * spelling for a label that already worked at runtime. `AppSelect` binds `$attrs`
 * to its button, so the attribute lands on the right element.
 *
 * This file must be a module (`export {}`) for `declare module 'vue'` to be a
 * module augmentation rather than an ambient re-declaration of `vue`.
 */
export {};

declare module 'vue' {
  interface ComponentCustomProps {
    /** Accessible name for a component's interactive element. */
    'aria-label'?: string;
    /** Whether the component's disclosure region is expanded. */
    'aria-expanded'?: boolean | 'true' | 'false';
  }
}
