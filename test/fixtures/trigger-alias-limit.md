---
a: &a [x]
b: &b [*a, *a]
c: &c [*b, *b]
d: &d [*c, *c]
e: &e [*d, *d]
f: &f [*e, *e]
g: &g [*f, *f]
---
Nested alias expansion reaches the YAML library limit.
