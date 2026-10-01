const PUBLIC_KEY_BASE64 = "ytpXllvXQ26FCoNhO8rFX0dJKFXYwJaN9uF1L2f2osg=";
const LEGACY_PUBLIC_KEY_BASE64 = "V3nI/I3ZPv1Ks8lqTSlDeyNhSJ4pvKXEezr6pPFt4hc=";

export const RELEASE_PUBLIC_KEY = Uint8Array.from(
  atob(PUBLIC_KEY_BASE64),
  (character) => character.charCodeAt(0),
);

/** Historical key retained only to validate explicitly-created compatibility packages. */
export const LEGACY_RELEASE_PUBLIC_KEY = Uint8Array.from(
  atob(LEGACY_PUBLIC_KEY_BASE64),
  (character) => character.charCodeAt(0),
);
