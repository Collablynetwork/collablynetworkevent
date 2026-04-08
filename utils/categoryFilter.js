// 🎯 Match: newProfile.categories ∩ user.lookingFor
function matchedProjectCategories(newProfile, user) {

  const categories = Array.isArray(newProfile?.categories)
    ? newProfile.categories
    : [];

  return categories.filter((cat) => user.lookingFor?.includes(cat)) || [];
}


// 🔍 Match: newProfile.lookingFor ∩ user.categories
function matchedLookingFor(newProfile, user) {
  const lookingFor = Array.isArray(newProfile?.lookingFor)
    ? newProfile.lookingFor
    : [];

  const categories = Array.isArray(user?.categories)
    ? user.categories
    : [];

  return lookingFor.filter((looking) => categories.includes(looking));
}



module.exports = {
  matchedProjectCategories,
  matchedLookingFor,
};