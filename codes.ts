import dotenv from "dotenv";
dotenv.config();

const BASE_URL = "https://api.the-odds-api.com/v4";
//const BASE_URL = "http://localhost:5000/v4";

const API_KEY = process.env.API_ONE;
const REGIONS = "eu";
const MARKETS = "h2h,totals,btts";

const FOOTBALL_DATA_BASE_URL = "https://api.football-data.org/v4";
//const FOOTBALL_DATA_BASE_URL = "http://localhost:6000/v4";

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;


// Free call - list all sports/leagues
export const getAllSportsUrl = () =>
  `${BASE_URL}/sports/?apiKey=${API_KEY}`;

// Free call - list fixtures for a league (no odds)
export const getEventsUrl = (sportKey: string) =>
  `${BASE_URL}/sports/${sportKey}/events/?apiKey=${API_KEY}`;

// Costs credits - odds for all games in a league
export const getOddsUrl = (sportKey: string) =>
  `${BASE_URL}/sports/${sportKey}/odds/?apiKey=${API_KEY}&regions=${REGIONS}&markets=${MARKETS}&oddsFormat=decimal&dateFormat=iso`;

// Costs credits - odds for one specific game
export const getEventOddsUrl = (sportKey: string, eventId: string) =>
  `${BASE_URL}/sports/${sportKey}/events/${eventId}/odds?apiKey=${API_KEY}&regions=${REGIONS}&markets=${MARKETS}&oddsFormat=decimal`;

export const FetchEplEvents = `${BASE_URL}/sports/soccer_epl/events/?apiKey=${API_KEY}`;

export const FetchEplOdds = (regions = 'uk', markets = 'h2h,totals,spreads') =>
  `${BASE_URL}/sports/soccer_epl/odds/?apiKey=${API_KEY}&regions=${regions}&markets=${markets}`;

export const FetchEplEventOdds = (eventId: string, regions = 'uk', markets = 'h2h,totals,spreads') =>
  `${BASE_URL}/sports/soccer_epl/events/${eventId}/odds/?apiKey=${API_KEY}&regions=${regions}&markets=${markets}`;


// Costs credits - fetches ALL available soccer/EPL market types for one game, UK bookmakers only
// Note: some markets require the /events/{eventId}/odds endpoint (not the bulk /odds endpoint) - this const uses that endpoint
export const FetchEplEventAllMarkets = (eventId: string) =>
  `${BASE_URL}/sports/soccer_epl/events/${eventId}/odds/?apiKey=${API_KEY}&regions=uk&markets=h2h,spreads,totals,btts,draw_no_bet,h2h_3_way,double_chance,alternate_spreads,alternate_totals,team_totals,alternate_team_totals,btts_h1,double_chance_h1,h2h_h1,h2h_h2,totals_h1,totals_h2,correct_score,correct_score_h1,halftime_fulltime,corners_1x2,alternate_totals_corners,alternate_spreads_corners,alternate_totals_cards,alternate_spreads_cards&oddsFormat=decimal&dateFormat=iso`;



export const getEplAllMatchesUrl = () =>
  `${FOOTBALL_DATA_BASE_URL}/competitions/PL/matches`;

export const footballDataFetchOptions = () => ({
  headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN ?? "" },
});