const handleGetTopicInstance = (req, res, next) => {
  res.render("planner/editInstace", { title: "Übersicht" });
};

const handlePutTopicInstance = (req, res, next) => {
  // API Request + Redirect to myClasses
};

const handleDeleteTopicInstance = (req, res, next) => {};

module.exports = {
  getTopicInstance: handleGetTopicInstance,
  putTopicInstance: handlePutTopicInstance,
  deleteTopicInstance: handleDeleteTopicInstance
};
