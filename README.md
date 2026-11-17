# gta6-twitch-ccu-forecast-01

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/gregorionainggolan8-tech/makefun-gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/gregorionainggolan8-tech/makefun-gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecasts GTA VI's launch-day Twitch viewers hour by hour (hours 2–24) from the
hour-1 print, as five quantiles per hour. Node 22, standard library only, no
network, deterministic.

## Model

The case's `comparables` hold past big launches' full 24-hour release-day
curves. For each usable comparable we take its log-ratio curve against its own
hour 1, `r_h = ln(viewers_h / viewers_1)`, and combine the curves into one
forecast anchored on the target's hour-1 print `p1`:

- **Post-unlock filter.** A launch whose hour 1 was still before its unlock has
  a tiny hour 1 and an exploding ratio curve (up to ~2000x). A comparable is kept
  only when its release day is complete (all 24 hourly points > 0), its hour 1
  is ≥ 1,000 viewers, and its hour 1 is ≥ 0.8x its own pre-release 24-hour
  median.
- **Scale weighting.** Curve shape depends on launch scale. Each comparable gets
  a Gaussian kernel weight in log hour-1 scale, `w = exp(-ln(v1/p1)^2 / 2)`, so
  launches near the target's size dominate. The per-hour median is the weighted
  median of the `r_h` values, lightly smoothed across neighbouring hours.
- **Spread.** The per-hour log spread is the weighted MAD (×1.4826) of the `r_h`
  values around the weighted median, clamped to [0.40, 0.90]. Quantiles are
  `q_tau = p1 * exp(m_h + z_tau * sigma_h)`.
- **Fallback.** With fewer than 3 usable curves, the house persistence baseline
  is used, so the output is always valid.

The model is fitted from the case file's own comparables at run time; only the
filter thresholds, kernel width and spread clamps are constants.

## Validation (leave-one-out over the comparables)

Each comparable is held out in turn, forecast from the others using its hour 1
as known, and scored with the contest's pinball loss against its actual hours
2–24 (same procedure for the persistence baseline):

| test set | this entry | persistence baseline |
| --- | --- | --- |
| post-unlock launches (n=124) | **0.378** | 0.725 |
| all complete-curve launches (n=148) | **0.411** | 0.930 |

## Run

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input dir, writes `<id>.out` (`{"hours": [...]}`,
23 rows, hours 2–24) to the output dir.
