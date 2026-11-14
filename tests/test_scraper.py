import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scraper'))
import scrape as s
def test_norm():
    q = s.norm('westernunion', 30000, 0.1853245, 150, 'added', 'x')
    assert q['receive_gbp'] == 5559.74 and q['pay_myr'] == 30150 and q['all_in_gbp'] == 5532.07
    w = s.norm('wise', 30000, 0.185175, 195.27, 'deducted', 'x'); assert w['receive_gbp'] == 5519.09
def test_alert():
    cfg = {'target_gbp': 5559.74, 'min_improvement_gbp': 5, 'repeat_after_hours': 3, 'quiet_hours_myt': [0, 7]}
    b = lambda v: {'id': 'wise', 'all_in_gbp': v}
    send, r, st = s.decide_alert(b(5550), cfg, {}, 0, 12); assert not send
    send, r, st = s.decide_alert(b(5565), cfg, st, 0, 12); assert send
    send, r, st = s.decide_alert(b(5566), cfg, st, 60, 12); assert not send
    send, r, st = s.decide_alert(b(5571), cfg, st, 120, 12); assert send and 'new high' in r
    send, r, st2 = s.decide_alert(b(5590), cfg, st, 200, 3); assert not send and r == 'quiet hours'
    send, r, st = s.decide_alert(b(5571), cfg, st, 120 + 3 * 3600, 12); assert send
def test_best_ignores_over_cap():
    qs = [s.norm('a', 30000, 0.19, 5, 'added', 'x', cap=14495), s.norm('b', 30000, 0.185, 0, 'added', 'x')]
    assert s.best_quote(qs)['id'] == 'b'
if __name__ == '__main__':
    for n, f in list(globals().items()):
        if n.startswith('test_'): f(); print('ok', n)
