"""Extract (date, stars) points from a star-history.com SVG chart.

The chart is rendered by https://api.star-history.com/svg: a path in plot
coordinates plus axis tick labels. Y is calibrated from two numeric ticks
("5K", "100"); X from the right edge (generation time) and the rightmost
readable date tick ("2024", "July", "Sep 27", "Wed 30"; hour ticks are ignored).
"""

import re
from datetime import date, datetime, timedelta, timezone

MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
         "November", "December"]
    )
}
SHORT_MONTHS = {m[:3]: i for m, i in MONTHS.items()}
TICK = re.compile(r'<text[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\)"[^>]*>([^<]*)</text>')
CURVE = re.compile(r'<path fill="none" stroke="#[0-9a-fA-F]{6}" d="([^"]+)" class="xkcd-chart-xyline"')
NUMBER = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?", re.I)


def parse_count(label: str) -> float | None:
    m = re.fullmatch(r"([\d.]+)\s*([KkMm]?)", label.strip())
    if not m:
        return None
    return float(m.group(1)) * {"": 1, "k": 1e3, "m": 1e6}[m.group(2).lower()]


def latest(before: date, month: int, day: int) -> date | None:
    """Most recent date <= before with this month and day."""
    for year in (before.year, before.year - 1):
        try:
            d = date(year, month, day)
        except ValueError:
            continue
        if d <= before:
            return d
    return None


def tick_date(label: str, before: date) -> date | None:
    """Date of a d3 time tick label; None for labels without a day (hours)."""
    label = label.strip()
    if re.fullmatch(r"\d{4}", label):
        return date(int(label), 1, 1)
    if label in MONTHS:
        return latest(before, MONTHS[label], 1)
    m = re.fullmatch(r"([A-Z][a-z]{2}) (\d{1,2})", label)
    if m and m.group(1) in SHORT_MONTHS:
        return latest(before, SHORT_MONTHS[m.group(1)], int(m.group(2)))
    if m:  # weekday + day of month
        day = int(m.group(2))
        d = before
        for _ in range(62):
            if d.day == day:
                return d
            d -= timedelta(days=1)
    return None


def path_points(d: str) -> list[tuple[float, float]]:
    """Segment endpoints of an SVG path (the actual data points of a smoothed line)."""
    points: list[tuple[float, float]] = []
    x = y = 0.0
    for cmd, args in re.findall(r"([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)", d):
        nums = [float(n) for n in NUMBER.findall(args)]
        step = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}[cmd.upper()]
        if step == 0:
            continue
        for i in range(0, len(nums) - step + 1, step):
            chunk = nums[i : i + step]
            rel = cmd.islower()
            u = cmd.upper()
            if u == "H":
                x = x + chunk[0] if rel else chunk[0]
            elif u == "V":
                y = y + chunk[0] if rel else chunk[0]
            else:
                x, y = (x + chunk[-2], y + chunk[-1]) if rel else (chunk[-2], chunk[-1])
            points.append((x, y))
    return points


def parse(svg: str, generated: datetime | None = None) -> list[tuple[str, int]]:
    """Return [(YYYY-MM-DD, stars)] or raise ValueError if the chart cannot be calibrated."""
    now_dt = generated or datetime.now(timezone.utc)
    now = now_dt.date()
    midnight = lambda d: datetime(d.year, d.month, d.day, tzinfo=timezone.utc)  # noqa: E731
    curve = CURVE.search(svg)
    if not curve:
        raise ValueError("no curve")
    pts = path_points(curve.group(1))
    if len(pts) < 2:
        raise ValueError("curve too short")
    ticks = [(float(x), float(y), label) for x, y, label in TICK.findall(svg)]
    y_ticks = [(y, parse_count(label)) for x, y, label in ticks if x == 0 and parse_count(label) is not None]
    x_axis_y = max((y for _, y, _ in ticks), default=0)
    x_ticks = [(x, label) for x, y, label in ticks if x != 0 and label.strip() and y >= x_axis_y - 1]
    if len(y_ticks) < 2 or not x_ticks:
        raise ValueError("not enough ticks")

    (y1, v1), (y2, v2) = y_ticks[0], y_ticks[-1]
    if y1 == y2:
        raise ValueError("flat y axis")

    right = max(p[0] for p in pts)  # the curve ends at the right edge = generation time
    dated = [(x, label, tick_date(label, now)) for x, label in sorted(x_ticks)]
    dated = [t for t in dated if t[2] is not None and midnight(t[2]) < now_dt - timedelta(hours=1)]
    if not dated:
        raise ValueError(f"no readable x tick in {[label for _, label in x_ticks]}")
    tx, _, anchor = dated[-1]
    if right <= tx:
        raise ValueError("x tick beyond the curve")
    days_per_px = (now_dt - midnight(anchor)).total_seconds() / 86400 / (right - tx)
    if len(dated) >= 2:  # sanity check with the previous readable tick
        px, plabel, _ = dated[-2]
        pdate = tick_date(plabel, anchor - timedelta(days=1))
        if pdate is not None and tx != px:
            expected = (anchor - pdate).days / (tx - px)
            if not 0.8 < expected / days_per_px < 1.25:
                raise ValueError("inconsistent x ticks")

    out: dict[str, int] = {}
    for px, py in pts:
        day = (now_dt - timedelta(days=(right - px) * days_per_px)).date()
        out[day.isoformat()] = max(0, round(v1 + (py - y1) * (v2 - v1) / (y2 - y1)))
    return sorted(out.items())
