/**
 * How far apart things are, relative to the original layout. Lower it to bring cities, terrain
 * regions and discoveries closer together; built places and the shape of dunes and ridges keep
 * their size. Cities need about 1.65 km of clear ground to their cell border, so do not go
 * below about 0.7 without also shrinking CITY_REACH_EXTRA.
 */
export const WORLD_SCALE = 0.75;
