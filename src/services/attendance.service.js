import { env } from '../config/env.js';
import { distanceMeters } from '../utils/geo.js';

/*
  Turns a phone's GPS reading into a punch (check-in or check-out).
  It never rejects: problems are returned as `issues`, the record is flagged as
  an exception, and the admin or engineer reviews it. GPS shows where the phone
  was. It does not prove who was holding it.
*/
export function evaluatePunch(project, gps = {}, now = new Date()) {
  const { latitude, longitude, accuracyMeters } = gps;
  const issues = [];
  const punch = { time: now, withinRadius: null };

  if (latitude == null || longitude == null) {
    issues.push('Location was not available (permission denied or GPS off).');
    return { punch, issues };
  }

  Object.assign(punch, { latitude, longitude, accuracyMeters });

  const poorAccuracy = accuracyMeters != null && accuracyMeters > env.MAX_GPS_ACCURACY_METERS;
  if (poorAccuracy) {
    issues.push(`GPS accuracy is low (about ${Math.round(accuracyMeters)} m).`);
  }

  const site = project.siteLocation;
  if (site?.latitude == null || site?.longitude == null) {
    issues.push('The site location is not set for this project, so distance could not be checked.');
    return { punch, issues };
  }

  const distance = Math.round(distanceMeters(latitude, longitude, site.latitude, site.longitude));
  const radius = site.radiusMeters ?? env.DEFAULT_SITE_RADIUS_METERS;
  punch.distanceFromSiteMeters = distance;

  // With poor accuracy the distance is unreliable, so we do not claim inside or outside
  if (!poorAccuracy) {
    punch.withinRadius = distance <= radius;
    if (!punch.withinRadius) issues.push(`You are ${distance} m from the site (allowed: ${radius} m).`);
  }
  return { punch, issues };
}