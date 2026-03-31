#!/usr/bin/env python3
"""
HMM Trainer — trains a 3-state GaussianHMM on hourly log-returns per pair.
Exports model as JSON for the TypeScript forward filter.
"""

import json
import sys
import numpy as np
from hmmlearn import hmm

DATA_DIR = "./backtest-data"
PAIRS = ["ETHUSDT", "SOLUSDT", "TAOUSDT"]
N_STATES = 2  # Data shows 2 natural regimes: normal + high-volatility spike


def load_candles(pair: str) -> list[dict]:
    import glob
    pattern = f"{DATA_DIR}/{pair}_1m_30d_*.json"
    files = sorted(glob.glob(pattern))
    if not files:
        raise FileNotFoundError(f"No candle file for {pair}: {pattern}")
    with open(files[-1]) as f:
        return json.load(f)


def candles_to_hourly_returns(candles: list[dict]) -> np.ndarray:
    closes = np.array([c["close"] for c in candles])
    # Aggregate to hourly (60 candles per hour)
    hourly_closes = []
    for i in range(0, len(closes) - 59, 60):
        hourly_closes.append(closes[i + 59])  # last close of the hour
    hourly_closes = np.array(hourly_closes)
    # Log returns
    returns = np.log(hourly_closes[1:] / hourly_closes[:-1])
    return returns


def train_hmm(returns: np.ndarray, n_states: int = 3):
    X = returns.reshape(-1, 1)
    model = hmm.GaussianHMM(
        n_components=n_states,
        covariance_type="full",
        n_iter=1000,
        random_state=42,
        tol=1e-6,
    )
    model.fit(X)

    # Sort states by variance (low-vol first, high-vol last)
    variances = np.array([model.covars_[i][0][0] for i in range(n_states)])
    sort_idx = np.argsort(variances)

    sorted_means = model.means_[sort_idx]
    sorted_covars = model.covars_[sort_idx]
    sorted_startprob = model.startprob_[sort_idx]
    sorted_transmat = model.transmat_[sort_idx][:, sort_idx]

    return {
        "means": sorted_means.flatten().tolist(),
        "covars": [float(sorted_covars[i][0][0]) for i in range(n_states)],
        "transmat": sorted_transmat.tolist(),
        "startprob": sorted_startprob.tolist(),
        "n_states": n_states,
        "score": float(model.score(X)),
    }


def validate_model(model_data: dict, pair: str):
    """Sanity checks on trained model."""
    tm = np.array(model_data["transmat"])

    # Check sticky diagonal (P(stay) should be > 0.5 for each state)
    diag = np.diag(tm)
    sticky = all(d > 0.5 for d in diag)

    # Check no degenerate states (all states reachable)
    reachable = all(model_data["startprob"][i] > 0.01 or any(tm[j][i] > 0.01 for j in range(len(tm))) for i in range(len(tm)))

    # Check variance ordering (state 0 = lowest vol, last = highest)
    covs = model_data["covars"]
    vars_ordered = all(covs[i] <= covs[i+1] for i in range(len(covs)-1))

    print(f"  {pair} validation:")
    print(f"    Sticky diagonal: {diag.round(3)} {'✓' if sticky else '⚠ NOT STICKY'}")
    print(f"    Reachable: {'✓' if reachable else '⚠ DEGENERATE'}")
    print(f"    Variance ordered: {'✓' if vars_ordered else '⚠ NOT ORDERED'}")
    print(f"    Means: {[f'{m:.6f}' for m in model_data['means']]}")
    print(f"    Variances: {[f'{v:.8f}' for v in model_data['covars']]}")
    print(f"    Log-likelihood: {model_data['score']:.2f}")

    return sticky and reachable


def main():
    results = {}

    for pair in PAIRS:
        print(f"\nTraining HMM for {pair}...")
        candles = load_candles(pair)
        print(f"  Loaded {len(candles)} candles")

        returns = candles_to_hourly_returns(candles)
        print(f"  Hourly returns: {len(returns)} observations")
        print(f"  Return stats: mean={returns.mean():.6f}, std={returns.std():.6f}")

        model_data = train_hmm(returns, N_STATES)
        model_data["pair"] = pair
        model_data["n_observations"] = len(returns)

        valid = validate_model(model_data, pair)

        # Save model
        out_path = f"{DATA_DIR}/{pair}_hmm_model.json"
        with open(out_path, "w") as f:
            json.dump(model_data, f, indent=2)
        print(f"  Saved to {out_path}")

        results[pair] = model_data

    # Print transition matrices
    print("\n" + "=" * 50)
    print("TRANSITION MATRICES (row=from, col=to)")
    print("States: 0=low-vol, 1=mid-vol, 2=high-vol")
    print("=" * 50)
    for pair, data in results.items():
        tm = np.array(data["transmat"])
        print(f"\n{pair}:")
        print(f"  From\\To  low-vol  mid-vol  high-vol")
        labels = ["low-vol", "mid-vol", "hi-vol "]
        for i, label in enumerate(labels):
            row = "  ".join(f"{tm[i][j]:.3f}" for j in range(3))
            print(f"  {label}  {row}")

        # Expected duration in each state
        durations = [1 / (1 - tm[i][i]) for i in range(3)]
        print(f"  Expected duration (hours): {[f'{d:.1f}h' for d in durations]}")


if __name__ == "__main__":
    main()
