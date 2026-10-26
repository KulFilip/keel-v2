// keel 0.18.57 Settings › Devices: the phones paired with this keel (keel's Android app), for the whole keel. "Pair a
// phone" is the tab's own button; the code, its QR and the list are components/Devices.tsx.

import { DevicesBody, useDevices } from "../../components/Devices";
import { SettingsFrame } from "./frame";

export function DevicesTab() {
  const st = useDevices();
  return (
    <SettingsFrame tab="devices" title="Devices" line="Phones paired with this keel (keel's Android app). For the whole keel."
      actions={!st.pairing ? <button className="ss-btn p" type="button" onClick={() => void st.startPairing()} disabled={st.busy}>Pair a phone</button> : undefined}>
      <DevicesBody st={st} />
    </SettingsFrame>
  );
}
