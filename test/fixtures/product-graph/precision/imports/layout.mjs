// Import lists laid out over lines, with a trailing comma and comments.
import {
  first,
  second as other,
  third, // why third
  /* a block note */ fourth,
} from "./names.mjs";
import Main, {
  extra,
  more as alias,
} from "./main.mjs";
import Whole, * as everything from "./whole.mjs";
import Spread,
  * as spreadAll
  from "./spread.mjs";
import * as
  nameSpace from "./space.mjs";
