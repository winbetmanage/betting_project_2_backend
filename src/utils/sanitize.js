const sanitizeUser = (user) => {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
};

module.exports = { sanitizeUser };
