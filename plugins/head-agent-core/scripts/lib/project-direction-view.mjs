import { readProjectDirection } from "./project-direction.mjs";

// Internal P4 read composition only. Effect/CAS guards use the strict original
// reader, never this diagnostic view. No pointer, revision or binding is changed.
export function readProjectDirectionView({ root = "." } = {}) {
  try { return { currentProjectDirection: readProjectDirection({ root }) }; }
  catch (error) {
    if (error?.code !== "PROJECT_DIRECTION_UNAVAILABLE") throw error;
    return { currentProjectDirection: null, currentProjectDirectionAvailability: {
      status: "unavailable", reasonCode: "PROJECT_DIRECTION_UNAVAILABLE", dependentEffectsBlocked: true,
    } };
  }
}

export function sameProjectDirectionView(first, second) {
  return (first.currentProjectDirection?.directionId || null) === (second.currentProjectDirection?.directionId || null)
    && (first.currentProjectDirectionAvailability?.status || "available-or-not-recorded")
      === (second.currentProjectDirectionAvailability?.status || "available-or-not-recorded");
}
