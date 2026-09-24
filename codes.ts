import dotenv from "dotenv";
dotenv.config();

// ============================================
// THE ODDS API
// ============================================

//const ODDS_API_BASE_URL = "https://api.the-odds-api.com/v4";
const ODDS_API_BASE_URL = "http://localhost:5000";

const ODDS_API_KEY = process.env.API_ONE;
const ODDS_API_REGIONS = "eu,uk";
const ODDS_API_MARKETS = "h2h,totals,btts";

// Every market type the odds api supports for soccer
const ODDS_API_ALL_MARKETS =
  "h2h,spreads,totals,btts,draw_no_bet,h2h_3_way,double_chance," +
  "alternate_spreads,alternate_totals,team_totals,alternate_team_totals," +
  "btts_h1,double_chance_h1,h2h_h1,h2h_h2,totals_h1,totals_h2," +
  "correct_score,correct_score_h1,halftime_fulltime,corners_1x2," +
  "alternate_totals_corners,alternate_spreads_corners," +
  "alternate_totals_cards,alternate_spreads_cards";

// Free call - list of all sports supported by the plan
export const getAllSportsUrl = () =>
  `${ODDS_API_BASE_URL}/sports/?apiKey=${ODDS_API_KEY}`;

// Free call - all EPL fixtures
export const getEplEventsUrl = () =>
  `${ODDS_API_BASE_URL}/sports/soccer_epl/events/?apiKey=${ODDS_API_KEY}`;

// Free call - all Champions League fixtures
export const getChampionsLeagueEventsUrl = () =>
  `${ODDS_API_BASE_URL}/sports/soccer_uefa_champs_league/events/?apiKey=${ODDS_API_KEY}`;

// Costs credits - single game detail (odds) for one event
// sportKey must match whichever competition the event belongs to
// (e.g. "soccer_epl" or "soccer_uefa_champs_league")
// markets: optional comma-separated list to fetch only specific market types
export const getOddsApiEventDetailUrl = (sportKey: string, eventId: string, markets: string = ODDS_API_MARKETS) =>
  `${ODDS_API_BASE_URL}/sports/${sportKey}/events/${eventId}/odds/?apiKey=${ODDS_API_KEY}&regions=${ODDS_API_REGIONS}&markets=${markets}&oddsFormat=decimal&dateFormat=iso`;

// Costs credits - ALL games in a competition, with EVERY market type, EU bookmakers
// sportKey: "soccer_epl" or "soccer_uefa_champs_league"
// markets: optional override (defaults to the full list); pass a smaller set if the
//          API plan rejects unsupported markets (The Odds API 422s the whole call if any
//          requested market is not on the plan).
// export const getAllMarketsOddsUrl = (sportKey: string, markets: string = ODDS_API_ALL_MARKETS) =>
//   `${ODDS_API_BASE_URL}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=${ODDS_API_REGIONS}&markets=${markets}&oddsFormat=decimal&dateFormat=iso`;

export const getAllMarketsOddsUrl = (sportKey: string, markets: string = `${ODDS_API_ALL_MARKETS},btts,double_chance,draw_no_bet`) =>
  `${ODDS_API_BASE_URL}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=${ODDS_API_REGIONS}&markets=${markets}&oddsFormat=decimal&dateFormat=iso`;

// ============================================
// FOOTBALL-DATA.ORG
// ============================================

//const FOOTBALL_DATA_BASE_URL = "https://api.football-data.org/v4";
const FOOTBALL_DATA_BASE_URL = "http://localhost:6060";

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;

export const footballDataFetchOptions = () => ({
  headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN ?? "" },
});

// All EPL matches
export const getEplMatchesUrl = () =>
  `${FOOTBALL_DATA_BASE_URL}/competitions/PL/matches`;

// All Champions League matches
export const getChampionsLeagueMatchesUrl = () =>
  `${FOOTBALL_DATA_BASE_URL}/competitions/CL/matches`;

// Single game detail
export const getFootballDataMatchDetailUrl = (matchId: string | number) =>
  `${FOOTBALL_DATA_BASE_URL}/matches/${matchId}`;