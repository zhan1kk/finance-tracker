import { TRANSACTION_CATEGORIES, type Subcategory } from "@/lib/types";

/**
 * <option> list for a subcategory picker, grouped by parent category.
 *
 * There are five of these pickers across the app (import review, the quick-add
 * form, the row editor, the split dialog, the rules page) and every one of them
 * used to render one flat alphabetical list. With a few dozen subcategories that
 * meant scanning the lot to find one entry, and two of them papered over it by
 * appending "(Expenses)" to every label. Grouping says the same thing with the
 * structure instead of repeating it on every line, and the browser draws a
 * separator between groups for free.
 *
 * Group order follows TRANSACTION_CATEGORIES so it matches the rest of the app.
 * Empty groups are dropped.
 *
 * Returns optgroups, so it must sit directly inside a <select>.
 */
export function SubcategoryOptions({
  subcategories,
  prefix = "",
}: {
  subcategories: Subcategory[];
  /** Prepended to each value, for pickers that namespace their options. */
  prefix?: string;
}) {
  const grouped = TRANSACTION_CATEGORIES.map((category) => ({
    category,
    items: subcategories.filter((s) => s.category === category),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      {grouped.map((g) => (
        <optgroup key={g.category} label={g.category}>
          {g.items.map((s) => (
            <option key={s.id} value={`${prefix}${s.id}`}>
              {s.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
