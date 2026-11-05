// Private P5 child-pipe framing, never a public command or persisted direction.
// Avoid PowerShell JSON command discovery without changing observer objects.
const LIMIT = 64 * 1024;
const invalid = () => { throw new Error("Invalid native process observation frame."); };
const uint = (text, maximum = 0xffffffffn) => {
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(text) || BigInt(text) > maximum) invalid();
  return Number(text);
};
const pid = text => { const value = uint(text); if (!value) invalid(); return value; };
const text = encoded => {
  if (!encoded || encoded.length > LIMIT || encoded.length % 4) invalid();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) invalid();
  const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!value) invalid();
  return value;
};
function frame(bytes, header) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMIT) invalid();
  // Only ASCII framing/base64 is permitted; arbitrary text is encoded, never
  // interpreted as a delimiter, executable instruction or provider identity.
  for (const value of bytes) if (value > 0x7f) invalid();
  const body = bytes.toString("ascii").replace(/\r\n/g, "\n");
  if (body.includes("\r") || !body.endsWith("\n")) invalid();
  const lines = body.slice(0, -1).split("\n");
  if (lines.shift() !== header || lines.pop() !== "END") invalid();
  return lines;
}
function count(line, maximum) {
  const fields = line?.split("\t");
  if (fields?.length !== 2 || fields[0] !== "COUNT") invalid();
  const value = uint(fields[1]);
  if (value > maximum) invalid();
  return value;
}
export function decodeWindowsProcessQueryWire(bytes, { startPid = null, stopPid = null, pids = [], maxRows } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > LIMIT) invalid();
  const lines = frame(bytes, "LODE-PROCESS-QUERY\t1");
  const machine = lines.shift()?.split("\t"), host = lines.shift()?.split("\t");
  if (machine?.length !== 2 || machine[0] !== "MACHINE" || host?.length !== 2 || host[0] !== "HOST") invalid();
  const length = count(lines.shift(), maxRows);
  if (lines.length !== length || startPid && !length || !startPid && length !== pids.length) invalid();
  const seen = new Set(), rows = lines.map((line, index) => {
    const fields = line.split("\t");
    if (fields.length !== 6 || fields[0] !== "ROW") invalid();
    const id = pid(fields[1]), state = fields[2];
    if (seen.has(id) || !["present", "gone", "unknown"].includes(state)
      || !startPid && id !== pids[index] || startPid && index === 0 && id !== startPid) invalid();
    seen.add(id);
    const row = { pid: id, state };
    if (state === "present") {
      row.ppid = uint(fields[3]);
      if (row.ppid === id || !/^(?:0|[1-9][0-9]{0,19})$/.test(fields[4]) || BigInt(fields[4]) > 0xffffffffffffffffn || fields[5] !== "-") invalid();
      row.birth = "windows-filetime-" + fields[4];
    } else {
      if (fields[3] !== "-" || fields[4] !== "-") invalid();
      if (fields[5] !== "-") row.errorCode = uint(fields[5]);
      if (state === "gone" && row.errorCode !== undefined && row.errorCode !== 87) invalid();
    }
    return row;
  });
  if (startPid) for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    if (previous.state !== "present" || previous.pid === stopPid || previous.ppid !== rows[i].pid) invalid();
  }
  const last = rows.at(-1);
  if (startPid && last.state === "present" && last.pid !== stopPid && last.ppid > 0 && rows.length < maxRows) invalid();
  return { machine: text(machine[1]), hostName: text(host[1]), rows };
}
export function decodeWindowsCodexInventoryWire(bytes) {
  const lines = frame(bytes, "LODE-CODEX-INVENTORY\t1");
  // The existing byte ceiling bounds inventory; do not impose the exact PID
  // witness's 16-row selection limit on a separate name-only inventory.
  const length = count(lines.shift(), LIMIT);
  if (lines.length !== length) invalid();
  const seen = new Set(), rows = lines.map(line => {
    const fields = line.split("\t");
    if (fields.length !== 4 || fields[0] !== "ROW") invalid();
    const id = pid(fields[1]), parentPid = uint(fields[2]), birth = text(fields[3]);
    if (seen.has(id) || parentPid === id || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(birth)
      || !Number.isFinite(Date.parse(birth)) || new Date(birth).toISOString() !== birth.slice(0, 23) + "Z" || birth.startsWith("0000")) invalid();
    seen.add(id);
    return { pid: id, parentPid, birth, home: "unresolved" };
  });
  return { status: "observed", rows };
}

// Fixed schema emitters use only .NET primitives already in Windows PowerShell.
// No JSON cmdlet, module discovery, profile, extra runtime or custom JSON encoder.
export const WINDOWS_PROCESS_QUERY_WIRE = String.raw`
$taskWireUtf8=[Text.UTF8Encoding]::new($false,$true)
function Encode-TaskWireText([string]$value){return [Convert]::ToBase64String($taskWireUtf8.GetBytes($value))}
function Write-TaskWireLine([string[]]$columns){[Console]::Out.WriteLine([String]::Join([string][char]9,$columns))}
function Write-TaskProcessQueryWire([string]$machine,[string]$hostName,[object[]]$rows){
  Write-TaskWireLine @('LODE-PROCESS-QUERY','1')
  Write-TaskWireLine @('MACHINE',(Encode-TaskWireText $machine))
  Write-TaskWireLine @('HOST',(Encode-TaskWireText $hostName))
  Write-TaskWireLine @('COUNT',$rows.Length.ToString([Globalization.CultureInfo]::InvariantCulture))
  foreach($row in $rows){
    $parent='-';$birth='-';$error='-'
    if($row.state -eq 'present'){$parent=$row.ppid.ToString([Globalization.CultureInfo]::InvariantCulture);$birth=$row.birth.Substring(17)}
    elseif($null -ne $row.errorCode){$error=$row.errorCode.ToString([Globalization.CultureInfo]::InvariantCulture)}
    Write-TaskWireLine @('ROW',$row.pid.ToString([Globalization.CultureInfo]::InvariantCulture),$row.state,$parent,$birth,$error)
  }
  [Console]::Out.WriteLine('END')
}
function Write-TaskCodexInventoryWire([object[]]$rows){
  Write-TaskWireLine @('LODE-CODEX-INVENTORY','1')
  Write-TaskWireLine @('COUNT',$rows.Length.ToString([Globalization.CultureInfo]::InvariantCulture))
  foreach($row in $rows){Write-TaskWireLine @('ROW',$row.pid.ToString([Globalization.CultureInfo]::InvariantCulture),$row.parentPid.ToString([Globalization.CultureInfo]::InvariantCulture),(Encode-TaskWireText $row.birth))}
  [Console]::Out.WriteLine('END')
}
`;
