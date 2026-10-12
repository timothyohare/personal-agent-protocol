// Seed NRL data for the demo. Fictional fixtures for a "current round"; not real results.

export interface Fixture {
  id: string;
  round: number;
  home: string;
  away: string;
  venue: string;
  kickoff: string;
}

export const TEAMS = [
  "Broncos", "Raiders", "Bulldogs", "Sharks", "Dolphins", "Titans", "Sea Eagles", "Storm", "Knights",
  "Cowboys", "Eels", "Panthers", "Rabbitohs", "Dragons", "Roosters", "Warriors", "Wests Tigers",
] as const;

export const CURRENT_ROUND = 27;

export const FIXTURES: Fixture[] = [
  { id: "r27-1", round: 27, home: "Storm", away: "Broncos", venue: "AAMI Park", kickoff: "2026-10-15T09:50:00Z" },
  { id: "r27-2", round: 27, home: "Panthers", away: "Sharks", venue: "BlueBet Stadium", kickoff: "2026-10-16T08:00:00Z" },
  { id: "r27-3", round: 27, home: "Roosters", away: "Rabbitohs", venue: "Allianz Stadium", kickoff: "2026-10-16T09:55:00Z" },
  { id: "r27-4", round: 27, home: "Cowboys", away: "Dolphins", venue: "Queensland Country Bank Stadium", kickoff: "2026-10-17T07:30:00Z" },
  { id: "r27-5", round: 27, home: "Warriors", away: "Knights", venue: "Go Media Stadium", kickoff: "2026-10-17T05:00:00Z" },
  { id: "r27-6", round: 27, home: "Sea Eagles", away: "Eels", venue: "4 Pines Park", kickoff: "2026-10-17T09:35:00Z" },
  { id: "r27-7", round: 27, home: "Raiders", away: "Bulldogs", venue: "GIO Stadium", kickoff: "2026-10-18T04:00:00Z" },
  { id: "r27-8", round: 27, home: "Titans", away: "Dragons", venue: "Cbus Super Stadium", kickoff: "2026-10-18T06:15:00Z" },
  { id: "r28-1", round: 28, home: "Broncos", away: "Panthers", venue: "Suncorp Stadium", kickoff: "2026-10-22T09:50:00Z" },
  { id: "r28-2", round: 28, home: "Sharks", away: "Storm", venue: "Ocean Protect Stadium", kickoff: "2026-10-23T08:00:00Z" },
  { id: "r28-3", round: 28, home: "Rabbitohs", away: "Cowboys", venue: "Accor Stadium", kickoff: "2026-10-23T09:55:00Z" },
  { id: "r28-4", round: 28, home: "Dolphins", away: "Warriors", venue: "Suncorp Stadium", kickoff: "2026-10-24T07:30:00Z" },
];

export const LADDER: { team: string; played: number; won: number; lost: number; points: number }[] = [
  ["Storm", 26, 20, 6], ["Panthers", 26, 19, 7], ["Broncos", 26, 17, 9], ["Sharks", 26, 16, 10],
  ["Roosters", 26, 15, 11], ["Cowboys", 26, 14, 12], ["Warriors", 26, 14, 12], ["Dolphins", 26, 13, 13],
  ["Rabbitohs", 26, 12, 14], ["Sea Eagles", 26, 12, 14], ["Knights", 26, 11, 15], ["Raiders", 26, 11, 15],
  ["Bulldogs", 26, 10, 16], ["Eels", 26, 9, 17], ["Dragons", 26, 8, 18], ["Titans", 26, 7, 19], ["Wests Tigers", 26, 6, 20],
].map(([team, played, won, lost]) => ({
  team: team as string, played: played as number, won: won as number, lost: lost as number, points: (won as number) * 2,
}));
