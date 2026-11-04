/** Emergency module barrel export (P6). */

export { useEmergency, type EmergencyState, type EmergencyContext, type EmergencyActions } from "./EmergencyStateMachine";
export { EmergencyButton } from "./EmergencyButton";
export { EmergencyScreen } from "./EmergencyScreen";
export { useVoiceHelp } from "./useVoiceHelp";
export { EmergencyDemoPage } from "./EmergencyDemoPage";
export { DebugStrip, useDebugMode } from "./DebugStrip";
export { EmergencyProvider, useEmergencyContext } from "./EmergencyContext";