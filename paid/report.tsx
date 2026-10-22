import { createRoot } from "react-dom/client";
import Dashboard from "../components/Dashboard";
import type { ComponentProps } from "react";
/** Delivered by the authenticated backend only. Report props never cross a network. */
export function mount(
  element: HTMLElement,
  props: ComponentProps<typeof Dashboard>,
) {
  const root = createRoot(element);
  root.render(<Dashboard {...props} />);
  return root;
}
