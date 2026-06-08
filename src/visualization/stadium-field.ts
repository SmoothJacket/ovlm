/**
 * Procedural MLB stadium 3D field models — all 30 current parks, to scale.
 *
 * Coordinate system matches OVLM world frame:
 *   origin = center of home plate at ground level
 *   +Z     = toward center field (pitcher's mound)
 *   +X     = toward first base
 *   +Y     = up
 *
 * All distances in feet converted to meters via FT constant.
 * Outfield wall angles measured from the +Z (center field) axis:
 *   -45° = left-field foul line, 0° = dead center, +45° = right-field foul line
 */

import * as THREE from 'three';

const FT = 0.3048; // feet → meters
const N_WALL = 128; // wall sample resolution
const WARNING_TRACK_FT = 15; // standard warning track width

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface WallPoint {
  angleDeg: number;    // degrees from center-field axis (-45 = LF, +45 = RF)
  distanceFt: number;  // distance from home plate in feet
  heightFt: number;    // wall height in feet
}

export interface StadiumConfig {
  id: string;
  name: string;
  shortName: string;
  city: string;
  team: string;
  league: 'AL' | 'NL';
  division: 'East' | 'Central' | 'West';
  wallPoints: WallPoint[];
  /** Primary team color for wall accent / foul poles */
  primaryColor: number;
  /** Secondary color for field markings */
  accentColor: number;
  /** True = artificial turf (slightly different green) */
  turf: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function interpolateWall(
  angleDeg: number,
  pts: WallPoint[],
): { distFt: number; heightFt: number } {
  const sorted = [...pts].sort((a, b) => a.angleDeg - b.angleDeg);
  const clampedAngle = Math.max(sorted[0].angleDeg, Math.min(sorted[sorted.length - 1].angleDeg, angleDeg));

  for (let i = 0; i < sorted.length - 1; i++) {
    if (clampedAngle >= sorted[i].angleDeg && clampedAngle <= sorted[i + 1].angleDeg) {
      const t = (clampedAngle - sorted[i].angleDeg) / (sorted[i + 1].angleDeg - sorted[i].angleDeg);
      return {
        distFt: sorted[i].distanceFt + t * (sorted[i + 1].distanceFt - sorted[i].distanceFt),
        heightFt: sorted[i].heightFt + t * (sorted[i + 1].heightFt - sorted[i].heightFt),
      };
    }
  }
  return { distFt: sorted[sorted.length - 1].distanceFt, heightFt: sorted[sorted.length - 1].heightFt };
}

/** Convert polar field angle (degrees from +Z) + distance to world XZ position */
function fieldPos(angleDeg: number, distFt: number, y = 0): THREE.Vector3 {
  const a = (angleDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(a) * distFt * FT, y, Math.cos(a) * distFt * FT);
}

// ──────────────────────────────────────────────────────────────────────────────
// Stadium data — 30 current MLB parks (2025)
// Dimensions sourced from official MLB park data; minor variations in LCF/RCF are approximated.
// ──────────────────────────────────────────────────────────────────────────────

export const STADIUMS: StadiumConfig[] = [
  // ── AL East ──────────────────────────────────────────────────────────────
  {
    id: 'yankee',
    name: 'Yankee Stadium',
    shortName: 'Yankee',
    city: 'Bronx, NY',
    team: 'New York Yankees',
    league: 'AL', division: 'East',
    primaryColor: 0x003087, accentColor: 0xC4CED4, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 318, heightFt: 8 },
      { angleDeg: -20, distanceFt: 399, heightFt: 8 },
      { angleDeg:   0, distanceFt: 408, heightFt: 8 },
      { angleDeg:  20, distanceFt: 385, heightFt: 8 },
      { angleDeg:  45, distanceFt: 314, heightFt: 8 },
    ],
  },
  {
    id: 'fenway',
    name: 'Fenway Park',
    shortName: 'Fenway',
    city: 'Boston, MA',
    team: 'Boston Red Sox',
    league: 'AL', division: 'East',
    primaryColor: 0xBD3039, accentColor: 0x0C2340, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 310, heightFt: 37.2 }, // Green Monster LF foul pole
      { angleDeg: -33, distanceFt: 360, heightFt: 37.2 }, // Monster continues
      { angleDeg: -22, distanceFt: 379, heightFt: 17  }, // LCF — wall drops at triangle
      { angleDeg:   0, distanceFt: 420, heightFt: 17  }, // CF
      { angleDeg:  20, distanceFt: 380, heightFt:  5  }, // RCF
      { angleDeg:  35, distanceFt: 325, heightFt:  5  }, // RF area
      { angleDeg:  45, distanceFt: 302, heightFt:  3  }, // Pesky's Pole (RF)
    ],
  },
  {
    id: 'rogers',
    name: 'Rogers Centre',
    shortName: 'Rogers',
    city: 'Toronto, ON',
    team: 'Toronto Blue Jays',
    league: 'AL', division: 'East',
    primaryColor: 0x134A8E, accentColor: 0xE8291C, turf: true,
    wallPoints: [
      { angleDeg: -45, distanceFt: 328, heightFt: 10 },
      { angleDeg: -20, distanceFt: 375, heightFt: 10 },
      { angleDeg:   0, distanceFt: 400, heightFt: 10 },
      { angleDeg:  20, distanceFt: 375, heightFt: 10 },
      { angleDeg:  45, distanceFt: 328, heightFt: 10 },
    ],
  },
  {
    id: 'camden',
    name: 'Camden Yards',
    shortName: 'Camden',
    city: 'Baltimore, MD',
    team: 'Baltimore Orioles',
    league: 'AL', division: 'East',
    primaryColor: 0xDF4601, accentColor: 0x27251F, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 333, heightFt: 7 },
      { angleDeg: -20, distanceFt: 364, heightFt: 7 },
      { angleDeg:   0, distanceFt: 410, heightFt: 7 },
      { angleDeg:  20, distanceFt: 373, heightFt: 7 },
      { angleDeg:  45, distanceFt: 318, heightFt: 7 },
    ],
  },
  {
    id: 'tropicana',
    name: 'Tropicana Field',
    shortName: 'Trop',
    city: 'St. Petersburg, FL',
    team: 'Tampa Bay Rays',
    league: 'AL', division: 'East',
    primaryColor: 0x092C5C, accentColor: 0x8FBCE6, turf: true,
    wallPoints: [
      { angleDeg: -45, distanceFt: 315, heightFt: 11 },
      { angleDeg: -20, distanceFt: 370, heightFt: 11 },
      { angleDeg:   0, distanceFt: 404, heightFt: 11 },
      { angleDeg:  20, distanceFt: 370, heightFt: 11 },
      { angleDeg:  45, distanceFt: 322, heightFt: 11 },
    ],
  },

  // ── AL Central ───────────────────────────────────────────────────────────
  {
    id: 'guaranteed',
    name: 'Guaranteed Rate Field',
    shortName: 'Guaranteed',
    city: 'Chicago, IL',
    team: 'Chicago White Sox',
    league: 'AL', division: 'Central',
    primaryColor: 0x27251F, accentColor: 0xC4CED4, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 330, heightFt: 8 },
      { angleDeg: -20, distanceFt: 377, heightFt: 8 },
      { angleDeg:   0, distanceFt: 400, heightFt: 8 },
      { angleDeg:  20, distanceFt: 372, heightFt: 8 },
      { angleDeg:  45, distanceFt: 335, heightFt: 8 },
    ],
  },
  {
    id: 'progressive',
    name: 'Progressive Field',
    shortName: 'Progressive',
    city: 'Cleveland, OH',
    team: 'Cleveland Guardians',
    league: 'AL', division: 'Central',
    primaryColor: 0xE31937, accentColor: 0x002B5C, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 325, heightFt: 19 },
      { angleDeg: -20, distanceFt: 370, heightFt: 19 },
      { angleDeg:   0, distanceFt: 405, heightFt:  8 },
      { angleDeg:  20, distanceFt: 375, heightFt:  8 },
      { angleDeg:  45, distanceFt: 325, heightFt:  8 },
    ],
  },
  {
    id: 'kauffman',
    name: 'Kauffman Stadium',
    shortName: 'Kauffman',
    city: 'Kansas City, MO',
    team: 'Kansas City Royals',
    league: 'AL', division: 'Central',
    primaryColor: 0x004687, accentColor: 0xC09A5B, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 330, heightFt:  9 },
      { angleDeg: -20, distanceFt: 387, heightFt:  9 },
      { angleDeg:   0, distanceFt: 410, heightFt:  9 },
      { angleDeg:  20, distanceFt: 387, heightFt:  9 },
      { angleDeg:  45, distanceFt: 330, heightFt:  9 },
    ],
  },
  {
    id: 'comerica',
    name: 'Comerica Park',
    shortName: 'Comerica',
    city: 'Detroit, MI',
    team: 'Detroit Tigers',
    league: 'AL', division: 'Central',
    primaryColor: 0x0C2340, accentColor: 0xFA4616, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 345, heightFt:  8 },
      { angleDeg: -20, distanceFt: 370, heightFt:  8 },
      { angleDeg:   0, distanceFt: 420, heightFt:  8 },
      { angleDeg:  20, distanceFt: 365, heightFt:  8 },
      { angleDeg:  45, distanceFt: 330, heightFt:  8 },
    ],
  },
  {
    id: 'target',
    name: 'Target Field',
    shortName: 'Target',
    city: 'Minneapolis, MN',
    team: 'Minnesota Twins',
    league: 'AL', division: 'Central',
    primaryColor: 0xC6011F, accentColor: 0x002B5C, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 339, heightFt:  8 },
      { angleDeg: -20, distanceFt: 377, heightFt:  8 },
      { angleDeg:   0, distanceFt: 411, heightFt:  8 },
      { angleDeg:  20, distanceFt: 373, heightFt:  8 },
      { angleDeg:  45, distanceFt: 328, heightFt:  8 },
    ],
  },

  // ── AL West ───────────────────────────────────────────────────────────────
  {
    id: 'tmobile',
    name: 'T-Mobile Park',
    shortName: 'T-Mobile',
    city: 'Seattle, WA',
    team: 'Seattle Mariners',
    league: 'AL', division: 'West',
    primaryColor: 0x0C2C56, accentColor: 0x005C5C, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 331, heightFt:  8 },
      { angleDeg: -20, distanceFt: 390, heightFt:  8 },
      { angleDeg:   0, distanceFt: 401, heightFt:  8 },
      { angleDeg:  20, distanceFt: 381, heightFt:  8 },
      { angleDeg:  45, distanceFt: 326, heightFt:  8 },
    ],
  },
  {
    id: 'globelife',
    name: 'Globe Life Field',
    shortName: 'Globe Life',
    city: 'Arlington, TX',
    team: 'Texas Rangers',
    league: 'AL', division: 'West',
    primaryColor: 0x003278, accentColor: 0xC0111F, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 329, heightFt: 8 },
      { angleDeg: -20, distanceFt: 372, heightFt: 8 },
      { angleDeg:   0, distanceFt: 407, heightFt: 8 },
      { angleDeg:  20, distanceFt: 374, heightFt: 8 },
      { angleDeg:  45, distanceFt: 326, heightFt: 8 },
    ],
  },
  {
    id: 'minutemaid',
    name: 'Minute Maid Park',
    shortName: 'Minute Maid',
    city: 'Houston, TX',
    team: 'Houston Astros',
    league: 'AL', division: 'West',
    primaryColor: 0xEB6E1F, accentColor: 0x002D62, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 315, heightFt:  7 },
      { angleDeg: -25, distanceFt: 362, heightFt:  7 },
      { angleDeg:   0, distanceFt: 409, heightFt:  7 },
      { angleDeg:  20, distanceFt: 373, heightFt:  7 },
      { angleDeg:  45, distanceFt: 326, heightFt:  7 },
    ],
  },
  {
    id: 'angel',
    name: 'Angel Stadium',
    shortName: 'Angel',
    city: 'Anaheim, CA',
    team: 'Los Angeles Angels',
    league: 'AL', division: 'West',
    primaryColor: 0xBA0021, accentColor: 0x003263, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 330, heightFt:  8 },
      { angleDeg: -20, distanceFt: 396, heightFt:  8 },
      { angleDeg:   0, distanceFt: 396, heightFt:  8 },
      { angleDeg:  20, distanceFt: 374, heightFt:  8 },
      { angleDeg:  45, distanceFt: 330, heightFt:  8 },
    ],
  },
  {
    id: 'sutterhealth',
    name: 'Sutter Health Park',
    shortName: 'Sutter Health',
    city: 'Sacramento, CA',
    team: 'Oakland Athletics',
    league: 'AL', division: 'West',
    primaryColor: 0x003831, accentColor: 0xEFB21E, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 330, heightFt:  8 },
      { angleDeg: -20, distanceFt: 375, heightFt:  8 },
      { angleDeg:   0, distanceFt: 404, heightFt:  8 },
      { angleDeg:  20, distanceFt: 375, heightFt:  8 },
      { angleDeg:  45, distanceFt: 325, heightFt:  8 },
    ],
  },

  // ── NL East ───────────────────────────────────────────────────────────────
  {
    id: 'citifield',
    name: 'Citi Field',
    shortName: 'Citi',
    city: 'Queens, NY',
    team: 'New York Mets',
    league: 'NL', division: 'East',
    primaryColor: 0x002D72, accentColor: 0xFF5910, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 335, heightFt:  8 },
      { angleDeg: -22, distanceFt: 358, heightFt:  8 },
      { angleDeg:   0, distanceFt: 408, heightFt:  8 },
      { angleDeg:  22, distanceFt: 358, heightFt:  8 },
      { angleDeg:  45, distanceFt: 330, heightFt:  8 },
    ],
  },
  {
    id: 'citizens',
    name: 'Citizens Bank Park',
    shortName: 'Citizens',
    city: 'Philadelphia, PA',
    team: 'Philadelphia Phillies',
    league: 'NL', division: 'East',
    primaryColor: 0xE81828, accentColor: 0x002D72, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 329, heightFt:  8 },
      { angleDeg: -20, distanceFt: 374, heightFt:  8 },
      { angleDeg:   0, distanceFt: 401, heightFt:  8 },
      { angleDeg:  20, distanceFt: 369, heightFt:  8 },
      { angleDeg:  45, distanceFt: 330, heightFt:  8 },
    ],
  },
  {
    id: 'truist',
    name: 'Truist Park',
    shortName: 'Truist',
    city: 'Cumberland, GA',
    team: 'Atlanta Braves',
    league: 'NL', division: 'East',
    primaryColor: 0xCE1141, accentColor: 0x002F5F, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 335, heightFt:  8 },
      { angleDeg: -20, distanceFt: 380, heightFt:  8 },
      { angleDeg:   0, distanceFt: 400, heightFt:  8 },
      { angleDeg:  20, distanceFt: 375, heightFt:  8 },
      { angleDeg:  45, distanceFt: 325, heightFt:  8 },
    ],
  },
  {
    id: 'loandepot',
    name: 'loanDepot Park',
    shortName: 'loanDepot',
    city: 'Miami, FL',
    team: 'Miami Marlins',
    league: 'NL', division: 'East',
    primaryColor: 0xFF6600, accentColor: 0x00A3E0, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 344, heightFt:  8 },
      { angleDeg: -20, distanceFt: 386, heightFt:  8 },
      { angleDeg:   0, distanceFt: 407, heightFt:  8 },
      { angleDeg:  20, distanceFt: 392, heightFt:  8 },
      { angleDeg:  45, distanceFt: 335, heightFt:  8 },
    ],
  },
  {
    id: 'nationals',
    name: 'Nationals Park',
    shortName: 'Nationals',
    city: 'Washington, DC',
    team: 'Washington Nationals',
    league: 'NL', division: 'East',
    primaryColor: 0xAB0003, accentColor: 0x14225A, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 336, heightFt:  8 },
      { angleDeg: -20, distanceFt: 377, heightFt:  8 },
      { angleDeg:   0, distanceFt: 402, heightFt:  8 },
      { angleDeg:  20, distanceFt: 370, heightFt:  8 },
      { angleDeg:  45, distanceFt: 335, heightFt:  8 },
    ],
  },

  // ── NL Central ───────────────────────────────────────────────────────────
  {
    id: 'wrigley',
    name: 'Wrigley Field',
    shortName: 'Wrigley',
    city: 'Chicago, IL',
    team: 'Chicago Cubs',
    league: 'NL', division: 'Central',
    primaryColor: 0x0E3386, accentColor: 0xCC3433, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 355, heightFt: 15 },
      { angleDeg: -20, distanceFt: 368, heightFt: 15 },
      { angleDeg:   0, distanceFt: 400, heightFt: 15 },
      { angleDeg:  20, distanceFt: 368, heightFt: 15 },
      { angleDeg:  45, distanceFt: 353, heightFt: 15 },
    ],
  },
  {
    id: 'greatamerican',
    name: 'Great American Ball Park',
    shortName: 'GABP',
    city: 'Cincinnati, OH',
    team: 'Cincinnati Reds',
    league: 'NL', division: 'Central',
    primaryColor: 0xC6011F, accentColor: 0x000000, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 328, heightFt: 12 },
      { angleDeg: -20, distanceFt: 370, heightFt: 12 },
      { angleDeg:   0, distanceFt: 404, heightFt: 12 },
      { angleDeg:  20, distanceFt: 370, heightFt: 12 },
      { angleDeg:  45, distanceFt: 325, heightFt: 12 },
    ],
  },
  {
    id: 'busch',
    name: 'Busch Stadium',
    shortName: 'Busch',
    city: 'St. Louis, MO',
    team: 'St. Louis Cardinals',
    league: 'NL', division: 'Central',
    primaryColor: 0xC41E3A, accentColor: 0x0C2340, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 336, heightFt:  8 },
      { angleDeg: -20, distanceFt: 375, heightFt:  8 },
      { angleDeg:   0, distanceFt: 400, heightFt:  8 },
      { angleDeg:  20, distanceFt: 375, heightFt:  8 },
      { angleDeg:  45, distanceFt: 335, heightFt:  8 },
    ],
  },
  {
    id: 'pnc',
    name: 'PNC Park',
    shortName: 'PNC',
    city: 'Pittsburgh, PA',
    team: 'Pittsburgh Pirates',
    league: 'NL', division: 'Central',
    primaryColor: 0xFDB827, accentColor: 0x27251F, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 325, heightFt:  6 },
      { angleDeg: -20, distanceFt: 383, heightFt:  6 },
      { angleDeg:   0, distanceFt: 399, heightFt:  6 },
      { angleDeg:  20, distanceFt: 375, heightFt:  6 },
      { angleDeg:  45, distanceFt: 320, heightFt:  6 },
    ],
  },
  {
    id: 'americanfamily',
    name: 'American Family Field',
    shortName: 'AmFam',
    city: 'Milwaukee, WI',
    team: 'Milwaukee Brewers',
    league: 'NL', division: 'Central',
    primaryColor: 0x12284B, accentColor: 0xFFC52F, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 342, heightFt:  8 },
      { angleDeg: -20, distanceFt: 371, heightFt:  8 },
      { angleDeg:   0, distanceFt: 400, heightFt:  8 },
      { angleDeg:  20, distanceFt: 374, heightFt:  8 },
      { angleDeg:  45, distanceFt: 345, heightFt:  8 },
    ],
  },

  // ── NL West ───────────────────────────────────────────────────────────────
  {
    id: 'oracle',
    name: 'Oracle Park',
    shortName: 'Oracle',
    city: 'San Francisco, CA',
    team: 'San Francisco Giants',
    league: 'NL', division: 'West',
    primaryColor: 0xFD5A1E, accentColor: 0x27251F, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 339, heightFt:  8 },
      { angleDeg: -20, distanceFt: 382, heightFt:  8 },
      { angleDeg:   0, distanceFt: 399, heightFt:  8 },
      { angleDeg:  20, distanceFt: 421, heightFt: 25 }, // right-center arcade
      { angleDeg:  35, distanceFt: 309, heightFt: 25 }, // RF arcade wall
      { angleDeg:  45, distanceFt: 309, heightFt: 25 },
    ],
  },
  {
    id: 'dodger',
    name: 'Dodger Stadium',
    shortName: 'Dodger',
    city: 'Los Angeles, CA',
    team: 'Los Angeles Dodgers',
    league: 'NL', division: 'West',
    primaryColor: 0x005A9C, accentColor: 0xEF3E42, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 330, heightFt:  4 },
      { angleDeg: -20, distanceFt: 375, heightFt:  4 },
      { angleDeg:   0, distanceFt: 395, heightFt:  8 },
      { angleDeg:  20, distanceFt: 375, heightFt:  4 },
      { angleDeg:  45, distanceFt: 330, heightFt:  4 },
    ],
  },
  {
    id: 'petco',
    name: 'Petco Park',
    shortName: 'Petco',
    city: 'San Diego, CA',
    team: 'San Diego Padres',
    league: 'NL', division: 'West',
    primaryColor: 0x2F241D, accentColor: 0xFFC425, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 336, heightFt:  8 },
      { angleDeg: -22, distanceFt: 367, heightFt:  8 },
      { angleDeg:   0, distanceFt: 396, heightFt:  8 },
      { angleDeg:  22, distanceFt: 391, heightFt:  8 },
      { angleDeg:  45, distanceFt: 322, heightFt:  8 },
    ],
  },
  {
    id: 'chase',
    name: 'Chase Field',
    shortName: 'Chase',
    city: 'Phoenix, AZ',
    team: 'Arizona Diamondbacks',
    league: 'NL', division: 'West',
    primaryColor: 0xA71930, accentColor: 0xE3D4AD, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 330, heightFt:  7 },
      { angleDeg: -20, distanceFt: 376, heightFt:  7 },
      { angleDeg:   0, distanceFt: 407, heightFt:  7 },
      { angleDeg:  20, distanceFt: 376, heightFt:  7 },
      { angleDeg:  45, distanceFt: 334, heightFt:  7 },
    ],
  },
  {
    id: 'coors',
    name: 'Coors Field',
    shortName: 'Coors',
    city: 'Denver, CO',
    team: 'Colorado Rockies',
    league: 'NL', division: 'West',
    primaryColor: 0x33006F, accentColor: 0xC4CED4, turf: false,
    wallPoints: [
      { angleDeg: -45, distanceFt: 347, heightFt:  8 },
      { angleDeg: -20, distanceFt: 390, heightFt:  8 },
      { angleDeg:   0, distanceFt: 415, heightFt:  8 },
      { angleDeg:  20, distanceFt: 375, heightFt:  8 },
      { angleDeg:  45, distanceFt: 350, heightFt:  8 },
    ],
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Infield geometry constants (same for all parks)
// ──────────────────────────────────────────────────────────────────────────────

const BASE_DIST = 27.432; // 90 feet in meters
// Base positions in world XZ (Y=0)
const FIRST_BASE  = new THREE.Vector3( BASE_DIST / Math.SQRT2, 0, BASE_DIST / Math.SQRT2);
const SECOND_BASE = new THREE.Vector3(0, 0, BASE_DIST * Math.SQRT2);
const THIRD_BASE  = new THREE.Vector3(-BASE_DIST / Math.SQRT2, 0, BASE_DIST / Math.SQRT2);
const MOUND_Z     = 18.44; // 60 ft 6 in

// ──────────────────────────────────────────────────────────────────────────────
// StadiumField
// ──────────────────────────────────────────────────────────────────────────────

export class StadiumField {
  private objects: THREE.Object3D[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  setStadium(id: string | null): void {
    this.dispose();
    if (!id) return;
    const cfg = STADIUMS.find((s) => s.id === id);
    if (!cfg) return;
    this.buildField(cfg);
  }

  dispose(): void {
    for (const obj of this.objects) {
      this.scene.remove(obj);
      if ('geometry' in obj && (obj as any).geometry) (obj as any).geometry.dispose();
      if ('material' in obj) {
        const mat = (obj as any).material;
        if (mat && typeof mat.dispose === 'function') mat.dispose();
      }
    }
    this.objects = [];
  }

  private add(obj: THREE.Object3D): void {
    this.scene.add(obj);
    this.objects.push(obj);
  }

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material, pos?: THREE.Vector3): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    if (pos) m.position.copy(pos);
    this.add(m);
    return m;
  }

  private buildField(cfg: StadiumConfig): void {
    this.buildFairGrass(cfg);
    this.buildWarningTrack(cfg);
    this.buildOutfieldWall(cfg);
    this.buildInfieldDirt();
    this.buildInfieldGrass();
    this.buildBases();
    this.buildPitchersMound();
    this.buildFoulLines(cfg);
    this.buildFoulPoles(cfg);
  }

  // ── Fair territory grass plane ────────────────────────────────────────────

  private buildFairGrass(cfg: StadiumConfig): void {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);

    for (let i = 0; i <= N_WALL; i++) {
      const angleDeg = -45 + (i / N_WALL) * 90;
      const angleRad = (angleDeg * Math.PI) / 180;
      const { distFt } = interpolateWall(angleDeg, cfg.wallPoints);
      const dist = distFt * FT;
      shape.lineTo(Math.sin(angleRad) * dist, Math.cos(angleRad) * dist);
    }
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape, 64);
    geo.rotateX(Math.PI / 2);

    const color = cfg.turf ? 0x1e5a14 : 0x1a3d12;
    const mat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = 0.001;
    this.add(m);
  }

  // ── Warning track (brown strip inside the outfield wall) ─────────────────

  private buildWarningTrack(cfg: StadiumConfig): void {
    const shape = new THREE.Shape();

    // Outer edge: wall contour
    for (let i = 0; i <= N_WALL; i++) {
      const angleDeg = -45 + (i / N_WALL) * 90;
      const angleRad = (angleDeg * Math.PI) / 180;
      const { distFt } = interpolateWall(angleDeg, cfg.wallPoints);
      const dist = distFt * FT;
      if (i === 0) shape.moveTo(Math.sin(angleRad) * dist, Math.cos(angleRad) * dist);
      else shape.lineTo(Math.sin(angleRad) * dist, Math.cos(angleRad) * dist);
    }

    // Inner edge: wall contour minus warning track width (traverse backwards)
    for (let i = N_WALL; i >= 0; i--) {
      const angleDeg = -45 + (i / N_WALL) * 90;
      const angleRad = (angleDeg * Math.PI) / 180;
      const { distFt } = interpolateWall(angleDeg, cfg.wallPoints);
      const dist = (distFt - WARNING_TRACK_FT) * FT;
      shape.lineTo(Math.sin(angleRad) * dist, Math.cos(angleRad) * dist);
    }
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape, 64);
    geo.rotateX(Math.PI / 2);

    const mat = new THREE.MeshLambertMaterial({ color: 0x3d2410, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = 0.002;
    this.add(m);
  }

  // ── Outfield wall (vertical face + top edge in team color) ───────────────

  private buildOutfieldWall(cfg: StadiumConfig): void {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= N_WALL; i++) {
      const angleDeg = -45 + (i / N_WALL) * 90;
      const angleRad = (angleDeg * Math.PI) / 180;
      const { distFt, heightFt } = interpolateWall(angleDeg, cfg.wallPoints);
      const dist = distFt * FT;
      const h = heightFt * FT;
      const x = Math.sin(angleRad) * dist;
      const z = Math.cos(angleRad) * dist;

      // Bottom vertex
      positions.push(x, 0.01, z);
      normals.push(-Math.sin(angleRad), 0, -Math.cos(angleRad));
      // Top vertex
      positions.push(x, h, z);
      normals.push(-Math.sin(angleRad), 0, -Math.cos(angleRad));
    }

    for (let i = 0; i < N_WALL; i++) {
      const b0 = i * 2;
      const t0 = i * 2 + 1;
      const b1 = (i + 1) * 2;
      const t1 = (i + 1) * 2 + 1;
      indices.push(b0, t0, b1, b1, t0, t1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);

    const mat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a, side: THREE.FrontSide });
    this.mesh(geo, mat);

    // Top edge in team primary color
    const topPts: THREE.Vector3[] = [];
    for (let i = 0; i <= N_WALL; i++) {
      const angleDeg = -45 + (i / N_WALL) * 90;
      const { distFt, heightFt } = interpolateWall(angleDeg, cfg.wallPoints);
      topPts.push(fieldPos(angleDeg, distFt, heightFt * FT));
    }
    const edgeGeo = new THREE.BufferGeometry().setFromPoints(topPts);
    const edgeMat = new THREE.LineBasicMaterial({ color: cfg.primaryColor, linewidth: 2 });
    this.add(new THREE.Line(edgeGeo, edgeMat));
  }

  // ── Infield dirt circle ───────────────────────────────────────────────────

  private buildInfieldDirt(): void {
    // Large circle covering home plate to just beyond second base
    const radius = SECOND_BASE.z / 2 + 5; // centered between home and 2B
    const cx = 0;
    const cz = SECOND_BASE.z / 2;

    const geo = new THREE.CircleGeometry(radius, 64);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ color: 0x5a3520, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(cx, 0.003, cz);
    this.add(m);
  }

  // ── Infield grass diamond (the grass square inside the bases) ─────────────

  private buildInfieldGrass(): void {
    const shape = new THREE.Shape();
    // Home → 1B → 2B → 3B → home (in XZ shape space)
    shape.moveTo(0, 0);
    shape.lineTo(FIRST_BASE.x, FIRST_BASE.z);
    shape.lineTo(SECOND_BASE.x, SECOND_BASE.z);
    shape.lineTo(THIRD_BASE.x, THIRD_BASE.z);
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ color: 0x1e4a1e, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = 0.004;
    this.add(m);
  }

  // ── Bases ─────────────────────────────────────────────────────────────────

  private buildBases(): void {
    const geo = new THREE.BoxGeometry(0.381, 0.076, 0.381); // 15" square, 3" thick
    const mat = new THREE.MeshLambertMaterial({ color: 0xfafafa });
    for (const pos of [FIRST_BASE, SECOND_BASE, THIRD_BASE]) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(pos.x, 0.038, pos.z);
      this.add(m);
    }

    // Home plate (pentagon) — flat on ground
    const pts = [
      new THREE.Vector2(-0.216, 0),
      new THREE.Vector2(0.216, 0),
      new THREE.Vector2(0.216, 0.216),
      new THREE.Vector2(0, 0.432),
      new THREE.Vector2(-0.216, 0.216),
    ];
    const plateShape = new THREE.Shape(pts);
    const plateGeo = new THREE.ShapeGeometry(plateShape);
    plateGeo.rotateX(Math.PI / 2);
    const plateMat = new THREE.MeshBasicMaterial({ color: 0xfafafa, side: THREE.DoubleSide });
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.position.y = 0.005;
    this.add(plate);
  }

  // ── Pitcher's mound ───────────────────────────────────────────────────────

  private buildPitchersMound(): void {
    // Mound: 18-foot diameter circle, raised 10 inches max
    const moundGeo = new THREE.CylinderGeometry(2.74, 3.05, 0.254, 32);
    const moundMat = new THREE.MeshLambertMaterial({ color: 0x5a3520 });
    const mound = new THREE.Mesh(moundGeo, moundMat);
    mound.position.set(0, 0.127, MOUND_Z);
    this.add(mound);

    // Pitcher's rubber: 24" × 6" white rectangle
    const rubberGeo = new THREE.BoxGeometry(0.61, 0.05, 0.152);
    const rubberMat = new THREE.MeshBasicMaterial({ color: 0xfafafa });
    const rubber = new THREE.Mesh(rubberGeo, rubberMat);
    rubber.position.set(0, 0.279, MOUND_Z);
    this.add(rubber);
  }

  // ── Foul lines ────────────────────────────────────────────────────────────

  private buildFoulLines(cfg: StadiumConfig): void {
    const lfAngle = -45;
    const rfAngle = +45;

    const lfPt = fieldPos(lfAngle, interpolateWall(lfAngle, cfg.wallPoints).distFt, 0.01);
    const rfPt = fieldPos(rfAngle, interpolateWall(rfAngle, cfg.wallPoints).distFt, 0.01);
    const origin = new THREE.Vector3(0, 0.01, 0);

    const points = [origin, lfPt, origin, rfPt];
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.9, transparent: true });
    this.add(new THREE.LineSegments(geo, mat));
  }

  // ── Foul poles ────────────────────────────────────────────────────────────

  private buildFoulPoles(cfg: StadiumConfig): void {
    const poleH = 10; // ~33 feet tall
    const poleR = 0.08;

    for (const angleDeg of [-45, 45]) {
      const { distFt } = interpolateWall(angleDeg, cfg.wallPoints);
      const base = fieldPos(angleDeg, distFt, 0);
      const { heightFt } = interpolateWall(angleDeg, cfg.wallPoints);
      const wallH = heightFt * FT;

      const geo = new THREE.CylinderGeometry(poleR, poleR, poleH, 8);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffff33 });
      const pole = new THREE.Mesh(geo, mat);
      // Position pole so its base sits on top of the outfield wall
      pole.position.set(base.x, wallH + poleH / 2, base.z);
      this.add(pole);
    }
  }
}
