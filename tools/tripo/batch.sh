#!/bin/zsh
# two candidates per species, a few at a time (Atlas/Tripo concurrency is limited)
S="stylised low-poly game asset, standing side-on in a neutral pose with all four legs straight and clearly separated, simple flat colours, clean silhouette, no base"
typeset -a J
J=(
"oryx_a|Arabian oryx antelope with two very long straight thin horns rising back from the head almost parallel, white coat, dark brown lower legs and black face mask, $S|3500"
"oryx_b|Arabian oryx, slender antelope, a pair of long straight spear-like horns swept straight back, pure white body, brown-black leg stockings, $S|3500"
"gazelle_a|dune gazelle, small slender antelope with short lyre-shaped ringed horns, sandy fawn back, white belly, a dark flank stripe, $S|3000"
"gazelle_b|Arabian sand gazelle, delicate, thin legs, short curved horns, pale sandy coat, white underside and rump, $S|3000"
"ass_a|wild ass, donkey-like equid with long ears, short upright mane, grey-fawn coat, pale muzzle and belly, a dark stripe along the spine, tufted tail, $S|3500"
"ass_b|Asiatic wild ass onager, sturdy horse-like body, long ears, upright mane, sandy coat with white belly, dark dorsal stripe, $S|3500"
"goat_a|mountain goat, stocky, backward-curving ridged horns, short beard, shaggy dark brown and tan coat, $S|3000"
"goat_b|desert goat with long drooping ears, small curved horns and a beard, black and tan coat, $S|3000"
"fox_a|fennec fox, tiny desert fox with enormous upright ears, cream coat, bushy black-tipped tail, $S|2000"
"fox_b|Ruppell's sand fox, slim, very large ears, pale sandy coat, white-tipped bushy tail, $S|2000"
"hare_a|desert hare, long upright ears, long hind legs, sandy grey-brown coat, sitting alert, $S|1800"
"hare_b|cape hare, very long ears with dark tips, lean body, buff coat, crouched alert pose, $S|1800"
"lizard_a|desert spiny-tailed lizard, flat body, four splayed legs, long thick tail, sandy speckled scales, $S|1200"
"lizard_b|desert monitor lizard, long body, splayed legs, long tapering tail, sandy yellow banded skin, $S|1200"
"tortoise_a|desert tortoise, high domed shell with clear hexagonal scutes, head and four stumpy legs out, olive-brown shell, $S|1800"
"tortoise_b|spur-thighed tortoise, domed patterned shell, small head out, elephant-like legs, $S|1800"
"snake_a|horned sand viper, short thick snake lying in a loose S curve, small horns above the eyes, sandy blotched skin, $S|1200"
"snake_b|desert sidewinder snake lying in an S curve, broad head, pale sandy skin with darker blotches, $S|1200"
"vulture_a|lappet-faced vulture with wings fully spread in a soaring glide, broad fingered wingtips, dark brown plumage, bare pinkish head, $S|2500"
"vulture_b|griffon vulture gliding with long broad wings spread, separated primary feathers, brown body, pale ruff, $S|2500"
"grouse_a|sandgrouse, plump ground bird, small head, short legs, pointed tail, sandy buff plumage with fine dark bars, $S|1500"
"grouse_b|pin-tailed sandgrouse, compact pigeon-like desert bird, long central tail pin, ochre and buff barred plumage, $S|1500"
"camel_a|dromedary camel, single hump, long curved neck, long legs with knobbly knees, broad padded feet, short tufted tail, sandy tan coat, no saddle, $S|4000"
"camel_b|Arabian dromedary, one large hump, long neck dipping then rising, heavy-lidded head, long legs, tan coat, no load, $S|4000"
)
eval "$(grep -E '^\s*export ATLASCLOUD_API_KEY=' ~/.zshrc)"
i=0
for j in "${J[@]}"; do
  IFS='|' read -r n p f <<< "$j"
  [ -f "out/$n.glb" ] && continue
  node gen.mjs "$n" "$p" "$f" > "log_$n.txt" 2>&1 &
  i=$((i+1))
  if (( i % 6 == 0 )); then wait; fi
done
wait
grep -h -E "done in|failed|submit failed|timeout" log_*.txt
