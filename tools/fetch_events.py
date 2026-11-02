"""ポケモンスリープ公式サイトのニュースからイベント・キャンペーンの情報を集めて events.json に書き出す。

- Python 標準ライブラリだけで動く(GitHub Actions から定期実行)
- 取り出すのはタイトル・カテゴリ・掲載日・開催期間・URL と、睡眠タイプに関する2つの印だけ。本文や画像は保存しない
- 一度見た記事の id は checkedIds に残し、次回からは取得しない。アクセスは間隔を空けて最小限にする

使い方: python tools/fetch_events.py [出力先 events.json]
"""
import html
import json
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SOURCE = 'https://www.pokemonsleep.net/news/'
CATEGORY_PAGES = {  # 一覧の1ページ目だけを見る(1ページ10件、お知らせは週に数件)
    'イベント': 'https://www.pokemonsleep.net/news/category/event/',
    'キャンペーン': 'https://www.pokemonsleep.net/news/category/campaign/',
}
USER_AGENT = 'sleep-type-tool-event-fetcher/1.0 (+https://github.com/MgH2-UMe91/sleep-type-tool)'
INTERVAL_SEC = 3          # リクエストの間隔
MAX_BYTES = 3 * 1024 * 1024  # 1ページの読み込み上限(公式ページは数百KB)
ARTICLE_PREFIX = 'https://www.pokemonsleep.net/news/'  # 記事として受け付けるURL(ほかのサイトへのリンクは取りに行かない)
SKIP_OLDER_DAYS = 45      # これより前の掲載記事は本文を取りに行かず、確認済みにだけする
KEEP_DAYS = 365           # 終了からこの日数を過ぎたイベントは消す
JST = timezone(timedelta(hours=9))
TYPE_WORDS = {'うとうと': 'uto', 'すやすや': 'suya', 'ぐっすり': 'gus'}

_last_request = 0.0


def fetch(url):
    global _last_request
    wait = _last_request + INTERVAL_SEC - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept-Language': 'ja'})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.read(MAX_BYTES).decode('utf-8', errors='replace')
    finally:
        _last_request = time.monotonic()


def article_id(url):
    m = re.search(r'/news/(\d+)/?$', url)
    return m.group(1) if m else None


def parse_list(page):
    """カテゴリ一覧から [{id, url, title, postedAt}] を取り出す"""
    items = []
    for m in re.finditer(r'<a class="banner_2" href="([^"]+)">(.*?)</a>', page, re.S):
        url, block = m.group(1), m.group(2)
        if not url.startswith(ARTICLE_PREFIX):
            continue
        aid = article_id(url)
        d = re.search(r'datetime="(\d{4})/(\d{2})/(\d{2})"', block)
        t = re.search(r'banner_2__title">\s*(.*?)\s*</p>', block, re.S)
        if not aid or not d or not t:
            continue
        items.append({
            'id': aid,
            'url': url,
            'title': html.unescape(re.sub(r'<[^>]+>', '', t.group(1))).strip(),
            'postedAt': f'{d.group(1)}-{d.group(2)}-{d.group(3)}',
        })
    return items


def page_text(page):
    """記事のHTMLを、段落ごとに1行のテキストにする(その場で使うだけで保存しない)"""
    s = re.sub(r'<(script|style|noscript)\b.*?</\1>', '', page, flags=re.S | re.I)
    s = re.sub(r'<!--.*?-->', '', s, flags=re.S)
    s = re.sub(r'<br\s*/?>|</?(p|div|li|ul|ol|h\d|section|article|tr|table|dt|dd)\b[^>]*>', '\n', s, flags=re.I)
    s = html.unescape(re.sub(r'<[^>]+>', '', s))
    lines = (re.sub(r'\s+', ' ', ln).strip() for ln in s.split('\n'))
    return '\n'.join(ln for ln in lines if ln)


DATE_RANGE = re.compile(
    r'(?:(\d{4})/)?(\d{1,2})/(\d{1,2})\s*(?:\([^)]*\))?\s*(\d{1,2}):(\d{2})'
    r'\s*[～〜~ー－-]\s*'
    r'(?:(\d{4})/)?(\d{1,2})/(\d{1,2})\s*(?:\([^)]*\))?\s*(\d{1,2}):(\d{2})')


def guess_year(month, posted):
    """年の書かれていない月日に年を補う。掲載月より半年以上前の月なら翌年とみなす(12月掲載の1月開催など)"""
    year = posted.year
    if month < posted.month - 6:
        year += 1
    elif month > posted.month + 6:
        year -= 1
    return year


def parse_period(text, posted):
    """【開催期間】の欄から最初の開始と最後の終了を返す。読めなければ (None, None)"""
    i = text.find('開催期間')
    if i < 0:
        return None, None
    section = text[i + len('開催期間'):]
    section = re.sub(r'^[】\]\s]*', '', section)
    j = section.find('【')
    section = section[:j if j >= 0 else 600]
    starts, ends = [], []
    for m in DATE_RANGE.finditer(section.replace('\n', ' ')):
        sy, sm, sd, sh, smin, ey, em, ed, eh, emin = m.groups()
        sm, sd, em, ed = int(sm), int(sd), int(em), int(ed)
        sy = int(sy) if sy else guess_year(sm, posted)
        ey = int(ey) if ey else sy
        try:
            start = datetime(sy, sm, sd, int(sh), int(smin), tzinfo=JST)
            end = datetime(ey, em, ed, int(eh), int(emin), tzinfo=JST)
        except ValueError:
            continue
        if end < start:  # 年またぎ(12/29 ～ 1/5 など)
            end = end.replace(year=end.year + 1)
        starts.append(start)
        ends.append(end)
    if not starts:
        return None, None
    return min(starts).isoformat(), max(ends).isoformat()


def parse_types(text):
    """睡眠タイプの印。typeFree: どのタイプでも出現 / boostTypes: 特定タイプの出現UP"""
    flat = text.replace('\n', '')
    type_free = bool(re.search(r'睡眠タイプに(限らず|関係なく|かかわらず|関わらず)|他の睡眠タイプのポケモンも出現', flat))
    boost = []
    # 箇条書き(行頭の・)ごとに、出現・出会いに関する項目だけを見る
    for item in re.split(r'\n(?=・)|\n', text):
        if '睡眠タイプに' in item or not re.search(r'出現|出会', item):
            continue
        for word, key in TYPE_WORDS.items():
            if re.search(word + r'(?:タイプ|・|、|/)', item) and key not in boost:
                boost.append(key)
    order = list(TYPE_WORDS.values())
    return type_free, sorted(boost, key=order.index)


def load(path):
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        if data.get('schemaVersion') == 1:
            return data
    except (OSError, ValueError):
        pass
    return {'checkedIds': [], 'events': []}


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'events.json'
    data = load(out)
    checked = list(data.get('checkedIds', []))
    events = {e['id']: e for e in data.get('events', [])}
    today = datetime.now(JST).date()
    changed = False

    for category, list_url in CATEGORY_PAGES.items():
        try:
            items = parse_list(fetch(list_url))
        except Exception as e:  # 一覧が取れない日は何も変えない
            print(f'一覧の取得に失敗: {list_url}: {e}', file=sys.stderr)
            continue
        if not items:
            print(f'一覧に記事が見つかりません(ページの形が変わった可能性): {list_url}', file=sys.stderr)
        for it in items:
            if it['id'] in checked:
                continue
            posted = date.fromisoformat(it['postedAt'])
            if (today - posted).days > SKIP_OLDER_DAYS:
                checked.append(it['id'])
                changed = True
                continue
            try:
                text = page_text(fetch(it['url']))
            except Exception as e:  # 次回また試す
                print(f'記事の取得に失敗: {it["url"]}: {e}', file=sys.stderr)
                continue
            start, end = parse_period(text, posted)
            type_free, boost = parse_types(text)
            events[it['id']] = {
                'id': it['id'],
                'title': it['title'],
                'category': category,
                'postedAt': it['postedAt'],
                'start': start,
                'end': end,
                'url': it['url'],
                'typeFree': type_free,
                'boostTypes': boost,
            }
            checked.append(it['id'])
            changed = True
            print(f'追加: {it["title"]} {start} ～ {end} typeFree={type_free} boost={boost}')

    # 終了から1年以上たったものは消す(id は確認済みに残す)
    limit = today - timedelta(days=KEEP_DAYS)
    for eid, e in list(events.items()):
        last = e['end'] or e['postedAt']
        if date.fromisoformat(last[:10]) < limit:
            del events[eid]
            changed = True

    if not changed and out.exists():
        print('変更なし')
        return
    result = {
        'schemaVersion': 1,
        'updatedAt': datetime.now(JST).replace(microsecond=0).isoformat(),
        'source': SOURCE,
        'checkedIds': checked,
        'events': sorted(events.values(), key=lambda e: (e['start'] or e['postedAt'], e['id']), reverse=True),
    }
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'書き出し: {out}(イベント {len(result["events"])} 件)')


if __name__ == '__main__':
    main()
