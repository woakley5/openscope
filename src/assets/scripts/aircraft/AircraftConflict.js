import Fiber from 'fiber';
import { vlen, vsub } from '../math/vector';
import { degreesToRadians } from '../utilities/unitConverters';

/**
 * Details about aircraft in close proximity in relation to 'the rules'
 *
 * @class AircraftConflict
 * @extends Fiber
 */
const AircraftConflict = Fiber.extend(function() {
    return {
        init: function(first, second) {
            this.aircraft = [first, second];
            this.distance = vlen(vsub(first.position, second.position));
            this.distance_delta = 0;
            this.altitude = abs(first.altitude - second.altitude);

            this.collided = false;

            this.conflicts = {};
            this.violations = {};

            this.aircraft[0].addConflict(this, second);
            this.aircraft[1].addConflict(this, first);

            this.update();
    },

    /**
     * Is there anything which should be brought to the controllers attention
     *
     * @returns {Array of Boolean} First element true if any conflicts/warnings,
     *                             Second element true if any violations.
     */
    hasAlerts: function() {
        return [this.hasConflict(), this.hasViolation()];
    },

    /**
     *  Whether any conflicts are currently active
     */
    hasConflict: function() {
      for (var i in this.conflicts) {
        if (this.conflicts[i])
          return true;
      }
      return false;
    },

    /**
     *  Whether any violations are currently active
     */
    hasViolation: function() {
      for (var i in this.violations) {
        if (this.violations[i])
          return true;
      }
      return false;
    },

    /**
     * Update conflict and violation checks, potentially removing this conflict.
     */
    update: function() {
      // Avoid triggering any more conflicts if the two aircraft have collided
      if (this.collided) return;

      var d = this.distance;
      this.distance = vlen(vsub(this.aircraft[0].position, this.aircraft[1].position));
      this.distance_delta = this.distance - d;
      this.altitude = abs(this.aircraft[0].altitude - this.aircraft[1].altitude);

      // Check if the separation is now beyond the bounding box check
      if (this.distance > 14.816) { // 14.816km = 8nm (max possible sep minmum)
        this.remove();
        return;
      }

      this.checkCollision();
      this.checkRunwayCollision();

      // Ignore aircraft below about 1000 feet
      var airportElevation = airport_get().elevation;
      if (((this.aircraft[0].altitude - airportElevation) < 990) ||
          ((this.aircraft[1].altitude - airportElevation) < 990))
        return;

      // Ignore aircraft in the first minute of their flight
      if ((game_time() - this.aircraft[0].takeoffTime < 60) ||
          (game_time() - this.aircraft[0].takeoffTime < 60)) {
        return;
      }

      this.checkProximity();
    },

    /**
     * Remove conflict for both aircraft
     */
    remove: function() {
      this.aircraft[0].removeConflict(this.aircraft[1]);
      this.aircraft[1].removeConflict(this.aircraft[0]);
    },

    /**
     * Check for collision
     */
    checkCollision: function() {
      if(this.aircraft[0].isLanded() || this.aircraft[1].isLanded()) return;  // TEMPORARY FIX FOR CRASHES BTWN ARRIVALS AND TAXIIED A/C
      // Collide within 160 feet
      if (((this.distance < 0.05) && (this.altitude < 160)) &&
          (this.aircraft[0].isVisible() && this.aircraft[1].isVisible()))
      {
        this.collided = true;
        ui_log(true,
               this.aircraft[0].getCallsign() + " collided with "
               + this.aircraft[1].getCallsign());
        prop.game.score.hit += 1;
        this.aircraft[0].hit = true;
        this.aircraft[1].hit = true;

        // If either are in runway queue, remove them from it
        for(var i in airport_get().runways) {
          var rwy = airport_get().runways[i];

          // Primary End of Runway
          rwy[0].removeQueue(this.aircraft[0], true);
          rwy[0].removeQueue(this.aircraft[1], true);

          // Secondary End of Runway
          rwy[1].removeQueue(this.aircraft[0], true);
          rwy[1].removeQueue(this.aircraft[1], true);
        }
      }
    },

    /**
     * Check for a potential head-on collision on a runway
     */
    checkRunwayCollision: function() {
      // Check if the aircraft are on a potential collision course
      // on the runway
      var airport = airport_get();

      // Check for the same runway, different ends and under about 6 miles
      if ((!this.aircraft[0].isTaxiing() && !this.aircraft[1].isTaxiing()) &&
          (this.aircraft[0].rwy_dep != null) &&
          (this.aircraft[0].rwy_dep !=
           this.aircraft[1].rwy_dep) &&
          (airport.getRunway(this.aircraft[1].rwy_dep) ===
           airport.getRunway(this.aircraft[0].rwy_dep)) &&
          (this.distance < 10))
      {
        if (!this.conflicts.runwayCollision) {
          this.conflicts.runwayCollision = true;
          ui_log(true, this.aircraft[0].getCallsign()
                 + " appears on a collision course with "
                 + this.aircraft[1].getCallsign()
                 + " on the same runway");
          prop.game.score.warning += 1;
        }
      }
      else {
        this.conflicts.runwayCollision = false;
      }
    },

    /**
     * Check for physical proximity and trigger crashes if necessary
     */
    checkProximity: function() {
      // No conflict or warning if vertical separation is present
      if (this.altitude >= 1000) {
        this.conflicts.proximityConflict = false;
        this.conflicts.proximityViolation = false;
        return;
      }

      var conflict = false;
      var violation = false;
      var disableNotices = false;
      var a1 = this.aircraft[0], a2 = this.aircraft[1];


      // Standard Basic Lateral Separation Minimum
      var applicableLatSepMin = 5.556;  // 3.0nm


      // Established on precision guided approaches
      if ( (a1.isPrecisionGuided() && a2.isPrecisionGuided()) &&
           (a1.rwy_arr != a2.rwy_arr)) { // both are following different instrument approaches
        var runwayRelationship = airport_get().metadata.rwy[a1.rwy_arr][a2.rwy_arr];
        if (runwayRelationship.parallel) {
          // Determine applicable lateral separation minima for conducting
          // parallel simultaneous dependent approaches on these runways:
          disableNotices = true;  // hide notices for aircraft on adjacent final approach courses
          var feetBetween = km_ft(runwayRelationship.lateral_dist);
          if(feetBetween < 2500)  // Runways separated by <2500'
            var applicableLatSepMin = 5.556;  // 3.0nm
          else if(2500 <= feetBetween && feetBetween <= 3600) // 2500'-3600'
            var applicableLatSepMin = 1.852;  // 1.0nm
          else if(3600 <  feetBetween && feetBetween <= 4300) // 3600'-4300'
            var applicableLatSepMin = 2.778;  // 1.5nm
          else if(4300 <  feetBetween && feetBetween <= 9000) // 4300'-9000'
            var applicableLatSepMin = 3.704;  // 2.0nm
          else if(feetBetween > 9000) // Runways separated by >9000'
            var applicableLatSepMin = 5.556;  // 3.0nm
          // Note: The above does not take into account the (more complicated)
          // rules for dual/triple simultaneous parallel dependent approaches as
          // outlined by FAA JO 7110.65, para 5-9-7. Users playing at any of our
          // airports that have triple parallels may be able to "get away with"
          // the less restrictive rules, whilst their traffic may not be 100%
          // legal. It's just complicated and not currently worthwhile to add
          // rules for running trips at this point... maybe later. -@erikquinn
          // Reference: FAA JO 7110.65, section 5-9-6
        }
      }


      // Considering all of the above cases,...
      violation = (this.distance < applicableLatSepMin);
      conflict  = (this.distance < applicableLatSepMin + 1.852 && !disableNotices) || violation;  // +1.0nm


      // "Passing & Diverging" Rules (the "exception" to all of the above rules)
      if(conflict) { // test the below only if separation is currently considered insufficient
        var hdg_difference = abs(angle_offset(a1.groundTrack, a2.groundTrack));
        if (hdg_difference >= degreesToRadians(15)) {
          if (hdg_difference > degreesToRadians(165)) {  // 'opposite' courses
            if (this.distance_delta > 0) {  // OKAY IF the distance is increasing
              conflict = false;
              violation = false;
            }
          }
          else {  // 'same' or 'crossing' courses
            // Ray intersection from http://stackoverflow.com/a/2932601
            var ad = vturn(a1.groundTrack);
            var bd = vturn(a2.groundTrack);
            var dx = a2.position[0] - a1.position[0];
            var dy = a2.position[1] - a1.position[1];
            var det = bd[0] * ad[1] - bd[1] * ad[0];
            var u = (dy * bd[0] - dx * bd[1]) / det;  // a1's distance from point of convergence
            var v = (dy * ad[0] - dx * ad[1]) / det;  // a2's distance from point of convergence
            if ((u < 0) || (v < 0)) { // check if either a/c has passed the point of convergence
              conflict  = false;  // targets are diverging
              violation = false;  // targets are diverging
            }
            // Reference: FAA JO 7110.65, section 5-5-7-a-1:
            // (a) Aircraft are on opposite/reciprocal courses and you have observed
            // that they have passed each other; or aircraft are on same or crossing
            // courses/assigned radar vectors and one aircraft has crossed the
            // projected course of the other, and the angular difference between
            // their courses/assigned radar vectors is at least 15 degrees.
          }
        }
      }

      // Update Conflicts
      if (conflict) this.conflicts.proximityConflict = true;
      else this.conflicts.proximityConflict = false;
      if (violation) this.violations.proximityViolation = true;
      else this.violations.proximityViolation = false;
    }
  };
});

export default AircraftConflict;