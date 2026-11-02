/**
 * Inline SVG icons.
 *
 * No icon font, no image request. Every icon is decorative: the text beside it
 * carries the meaning, so each SVG is hidden from the accessibility tree.
 */

import { type Html, raw } from "./html.ts";

function icon(body: string, className = ""): Html {
  const classes = className === "" ? "icon" : `icon ${className}`;
  return raw(
    `<svg class="${classes}" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  );
}

export function iconInbox(): Html {
  return icon('<path d="M4 5.5h16v13H4z"/><path d="M4 14h4l1.5 2h5L16 14h4"/>', "icon--empty");
}

export function iconCheck(): Html {
  return icon('<path d="M5 12.5 9.5 17 19 7"/>');
}

export function iconCross(): Html {
  return icon('<path d="M6 6l12 12M18 6 6 18"/>');
}

export function iconAlert(): Html {
  return icon('<path d="M12 4 3.5 19.5h17z"/><path d="M12 9.5v4.5"/><path d="M12 17h.01"/>');
}

export function iconBlocked(): Html {
  return icon('<circle cx="12" cy="12" r="8"/><path d="m6.4 6.4 11.2 11.2"/>');
}

export function iconKey(): Html {
  return icon('<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H20"/><path d="M17 12v3"/>');
}

export function iconChart(): Html {
  return icon('<path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 15 4-5 3 3 5-6"/>');
}

export function iconSun(): Html {
  return icon(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
  );
}

export function iconMoon(): Html {
  return icon('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>');
}

export function iconSearch(): Html {
  return icon('<circle cx="11" cy="11" r="6"/><path d="m15.5 15.5 4.5 4.5"/>');
}

export function iconExternal(): Html {
  return icon('<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v6H4V6h6"/>');
}

export function iconUsers(): Html {
  return icon(
    '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><path d="M16 5.6a3 3 0 0 1 0 5.8"/><path d="M17 14.6c2 .5 3.2 1.9 3.5 4.4"/>',
  );
}

export function iconSetup(): Html {
  return icon(
    '<path d="M12 3.5 14 5l2.4-.4.9 2.3 2.2 1.1-.4 2.4 1.5 2-1.5 2 .4 2.4-2.2 1.1-.9 2.3L14 19l-2 1.5L10 19l-2.4.4-.9-2.3-2.2-1.1.4-2.4L3.4 12l1.5-2-.4-2.4 2.2-1.1.9-2.3L10 5z"/><circle cx="12" cy="12" r="3"/>',
  );
}

export function iconRules(): Html {
  return icon(
    '<path d="M8 6h11M8 12h11M8 18h8"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  );
}

export function iconShield(): Html {
  return icon(
    '<path d="M12 3.5 19 6v5c0 4.5-2.8 7.7-7 9.5-4.2-1.8-7-5-7-9.5V6z"/><path d="m9 12 2 2 4-4.5"/>',
  );
}

export function iconChevron(): Html {
  return icon('<path d="m8 10 4 4 4-4"/>');
}
