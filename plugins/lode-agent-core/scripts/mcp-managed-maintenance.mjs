#!/usr/bin/env node
// Explicit compatibility entry for settling retained managed work. Not a
// permission grant and never selected automatically by the ordinary server.
import { serveMcp } from "./mcp-server.mjs";
serveMcp({ surface: "managed-maintenance" });
