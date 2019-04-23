'use strict';

function Battle (participants) {
  this.participants = participants || [];
}

Battle.prototype.compute = function () {
  let order = this.participants.sort(function (a, b) {
    return a.initiative - b.initiative;
  });

  let a = order[0];
  let b = order[1];

  // TODO: actually implement real battles. :)
  console.log('battle occurring, ordered:', order);

  a.attack = (a.weapon) ? a.weapon.attack : 1;
  b.attack = (b.weapon) ? b.weapon.attack : 1;

  for (let i = 1; i < 100 && a.health > 10 && b.health > 10; i++) {
    this.volley(a, b);
  }
};

Battle.prototype.volley = function (a, b) {
  if (a.health > 0) b.health = b.health - a.attack;
  if (b.health > 0) a.health = a.health - b.attack;
};

module.exports = Battle;
