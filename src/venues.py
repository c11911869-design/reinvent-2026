"""re:Invent 2026 campus: venues and travel estimates between them.

SOURCING. AWS has not published a 2026 campus map or an official
venue-to-venue time table (aws.amazon.com/events/reinvent/campus/ is 404 as of
2026-09-02). What is documented and used here:

  - AWS advises allowing 30-45 minutes between activities, whether moving
    between venues or within one.
  - Free campus shuttles run between venues more than about a 15-minute walk
    apart. Wynn <-> Venetian and Caesars Forum <-> Venetian have no shuttle
    because they are walkable.
  - Encore and Wynn are directly connected. A bridge links Wynn and The
    Venetian. A temporary indoor route links Caesars Forum and The Venetian
    during Expo hours.
  - 2026 venues: Caesars Forum, Caesars Palace, Encore, MGM Grand, The
    Venetian, Wynn. Five sit in one run from Encore down to Caesars Palace;
    MGM Grand is the outlier, south near Tropicana.

WALK MINUTES BELOW ARE ESTIMATES, not official figures. They are door-to-door
and deliberately conservative. Never present them as AWS's numbers; the app
labels them as estimates and surfaces the 30-45 minute rule as the safe
default.
"""

# Canonical venue keys, ordered roughly north -> south along the Strip.
VENUES = [
    ("encore",        "Encore",         "Connected to Wynn."),
    ("wynn",          "Wynn",           "Bridge to The Venetian; connected to Encore."),
    ("venetian",      "The Venetian",   "Main venue; the Expo lives here."),
    ("caesars_forum", "Caesars Forum",  "Indoor route to The Venetian during Expo hours."),
    ("caesars_palace","Caesars Palace", "Adjacent to Caesars Forum."),
    ("mgm",           "MGM Grand",      "Outlier, south near Tropicana. Shuttle strongly advised."),
]
VENUE_NAME = {k: n for k, n, _ in VENUES}
VENUE_NOTE = {k: d for k, _, d in VENUES}

# Estimated door-to-door WALK minutes between venues (symmetric).
_WALK = {
    ("encore", "wynn"): 5,
    ("encore", "venetian"): 18,
    ("encore", "caesars_forum"): 30,
    ("encore", "caesars_palace"): 34,
    ("encore", "mgm"): 55,
    ("wynn", "venetian"): 14,
    ("wynn", "caesars_forum"): 26,
    ("wynn", "caesars_palace"): 30,
    ("wynn", "mgm"): 52,
    ("venetian", "caesars_forum"): 14,
    ("venetian", "caesars_palace"): 18,
    ("venetian", "mgm"): 42,
    ("caesars_forum", "caesars_palace"): 8,
    ("caesars_forum", "mgm"): 35,
    ("caesars_palace", "mgm"): 32,
}

# Pairs AWS documents as having NO shuttle (they are walkable).
_NO_SHUTTLE = {("wynn", "venetian"), ("caesars_forum", "venetian"),
               ("encore", "wynn"), ("caesars_forum", "caesars_palace")}

# Documented indoor / bridge connections worth calling out in the UI.
_CONNECTION = {
    ("encore", "wynn"): "Directly connected indoors.",
    ("wynn", "venetian"): "Bridge between Wynn and The Venetian.",
    ("caesars_forum", "venetian"): "Temporary indoor route during Expo hours.",
}

# Same-venue move: still budget time for a big property.
SAME_VENUE_MIN = 10


# The tables above are written in reading order; normalise every key to the
# sorted form the lookup uses, so pair order never matters.
_WALK = {tuple(sorted(k)): v for k, v in _WALK.items()}
_NO_SHUTTLE = {tuple(sorted(k)) for k in _NO_SHUTTLE}
_CONNECTION = {tuple(sorted(k)): v for k, v in _CONNECTION.items()}


def _key(a, b):
    return tuple(sorted((a, b)))


def travel(a, b):
    """Estimated travel between two venue keys.

    Returns a dict: minutes (best realistic estimate), walk, shuttle (bool),
    note, and same (bool). Unknown venues fall back to the conservative
    30-45 minute guidance.
    """
    if not a or not b:
        return None
    if a == b:
        return {"from": a, "to": b, "same": True, "minutes": SAME_VENUE_MIN,
                "walk": SAME_VENUE_MIN, "shuttle": False,
                "note": "Same venue, but these properties are large."}
    k = _key(a, b)
    walk = _WALK.get(k)
    if walk is None:
        return {"from": a, "to": b, "same": False, "minutes": 45, "walk": None,
                "shuttle": True, "note": "Unknown pair. Allow AWS's 30-45 minutes."}
    shuttle = k not in _NO_SHUTTLE and walk > 15
    # A shuttle helps on long legs but adds wait + boarding; treat it as
    # roughly two thirds of the walk, never below 15 minutes.
    minutes = max(15, round(walk * 2 / 3)) if shuttle else walk
    return {"from": a, "to": b, "same": False, "minutes": minutes, "walk": walk,
            "shuttle": shuttle, "note": _CONNECTION.get(k, "")}


def matrix():
    """Full symmetric travel matrix, for embedding in the page."""
    keys = [k for k, _, _ in VENUES]
    return {a: {b: travel(a, b) for b in keys if b != a} for a in keys}


# Map a catalog room string ("Mandalay Bay | Level 2 South | Oceanside C")
# to a venue key. Ordered longest-first so "Caesars Forum" wins over "Caesars".
ROOM_PREFIXES = [
    ("caesars forum", "caesars_forum"),
    ("caesars palace", "caesars_palace"),
    ("the venetian", "venetian"),
    ("venetian", "venetian"),
    ("mgm grand", "mgm"),
    ("mandalay bay", "mgm"),   # 2025 venue; nearest 2026 analogue for distance
    ("encore", "encore"),
    ("wynn", "wynn"),
    ("mgm", "mgm"),
    ("caesars", "caesars_forum"),
]


def venue_key(room):
    """Best-effort venue key from a catalog room string."""
    r = (room or "").strip().lower()
    for prefix, key in ROOM_PREFIXES:
        if r.startswith(prefix):
            return key
    return None
